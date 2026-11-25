const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const originalDbFile = process.env.DB_FILE;
const dbFile = path.join(os.tmpdir(), `sentinela-test-${process.pid}.json`);
process.env.DB_FILE = dbFile;

const app = require("./server");
let server;
let baseUrl;

before(async () => {
  fs.writeFileSync(dbFile, JSON.stringify({
    usuarios: [],
    pacientes: [],
    triagens: [],
    consultas: [
      { id: 1, paciente: "", medicacao: "", diagnostico: "" },
      { id: 2, paciente: "Paciente sem prescrição", medicacao: "", diagnostico: "Teste" }
    ],
    chamadas: []
  }));
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  if (originalDbFile === undefined) {
    delete process.env.DB_FILE;
  } else {
    process.env.DB_FILE = originalDbFile;
  }
});

async function requestJson(route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const data = await response.json();
  return { response, data };
}

test("encaminha as novas rotas do estoque e recebimento à API no Vercel", () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const sources = vercel.rewrites.map(rewrite => rewrite.source);
  const fallbackIndex = sources.indexOf("/(.*)");

  for (const route of ["/estoque", "/estoque/(.*)", "/medicacoes/(.*)/recebida"]) {
    assert.ok(sources.indexOf(route) >= 0);
    assert.ok(sources.indexOf(route) < fallbackIndex);
  }
});

test("autentica o administrador e os seis usuários de acesso", async () => {
  const loginAdmin = await requestJson("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "admin", senha: "1234" })
  });
  assert.equal(loginAdmin.response.status, 200);
  assert.equal(loginAdmin.data.tipo, "admin");

  const usuarios = ["atendimento", "triagem", "tv", "medico", "medicacoes", "almoxarifado"];

  for (const usuario of usuarios) {
    const cadastro = await requestJson("/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha: "1234", tipo: usuario })
    });
    assert.equal(cadastro.response.status, 201);

    const login = await requestJson("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha: "1234" })
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.tipo, usuario);
  }

  const senhaIncorreta = await requestJson("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "almoxarifado", senha: "senha-errada" })
  });
  assert.equal(senhaIncorreta.response.status, 401);

  const senhaAdminIncorreta = await requestJson("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "admin", senha: "senha-errada" })
  });
  assert.equal(senhaAdminIncorreta.response.status, 401);
});

test("executa cadastro, triagem, consulta e listagem de medicações", async () => {
  const health = await requestJson("/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.data.ok, true);

  const cadastro1 = await requestJson("/atendimento", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: "Paciente Um",
      cpf: "123.456.789-00",
      dataNascimento: "1990-01-01",
      sexo: "Prefiro não informar",
      nomeMae: "Responsável",
      estadoCivil: "Solteiro(a)",
      tipo: "Particular",
      telefone: "11999999999",
      contatoEmergencia: "11888888888",
      endereco: "Rua Um"
    })
  });
  assert.equal(cadastro1.response.status, 201);

  const cadastro2 = await requestJson("/atendimento", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: "Paciente Dois",
      cpf: "987.654.321-00",
      dataNascimento: "1991-02-02",
      sexo: "Prefiro não informar",
      nomeMae: "Responsável",
      estadoCivil: "Solteiro(a)",
      tipo: "Particular",
      telefone: "11999999998",
      contatoEmergencia: "11888888887",
      endereco: "Rua Dois"
    })
  });
  assert.equal(cadastro2.response.status, 201);

  const primeiraChamada = await requestJson("/tv/chamada");
  assert.ok(Number.isFinite(Date.parse(primeiraChamada.data.chamada.chamadaEm)));
  const primeiraTriagem = await requestJson("/triagem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pacienteId: primeiraChamada.data.chamada.pacienteId,
      sintomas: ["Febre"],
      alergia: "Nenhuma"
    })
  });
  assert.equal(primeiraTriagem.response.status, 201);
  assert.ok(primeiraTriagem.data.proximaChamada);

  const filaAposPrimeiraTriagem = await requestJson("/dashboard-summary");
  assert.equal(filaAposPrimeiraTriagem.data.stats.pacientesFila, 2);

  const segundaChamada = await requestJson("/tv/chamada");
  const segundaTriagem = await requestJson("/triagem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pacienteId: segundaChamada.data.chamada.pacienteId,
      sintomas: ["Tosse"],
      alergia: "Nenhuma"
    })
  });
  assert.equal(segundaTriagem.response.status, 201);
  assert.equal(segundaTriagem.data.proximaChamada, null);

  const triagens = await requestJson("/triagens");
  const idsPorNome = Object.fromEntries(
    triagens.data.map(triagem => [triagem.nome, triagem.id])
  );
  const chamadaMedica = await requestJson("/tv/chamar-proximo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ etapa: "CONSULTA" })
  });
  assert.equal(chamadaMedica.response.status, 200);
  assert.equal(String(chamadaMedica.data.chamada.triagemId), String(idsPorNome["Paciente Um"]));

  const chamadaMedicaAtual = await requestJson("/tv/chamada");
  assert.equal(chamadaMedicaAtual.data.chamada.localTipo, "CONSULTA");
  assert.equal(
    String(chamadaMedicaAtual.data.chamada.triagemId),
    String(idsPorNome["Paciente Um"])
  );

  const consulta = await requestJson("/consulta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paciente: "Paciente Um",
      cpf: "123.456.789-00",
      diagnostico: "Resfriado",
      medicacao: "Dipirona",
      triagemId: idsPorNome["Paciente Um"]
    })
  });
  assert.equal(consulta.response.status, 201);

  const triagensAposPrimeiraConsulta = await requestJson("/triagens");
  assert.equal(
    triagensAposPrimeiraConsulta.data.some(item => String(item.id) === String(idsPorNome["Paciente Um"])),
    false
  );

  const proximaChamadaMedica = await requestJson("/tv/chamar-proximo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ etapa: "CONSULTA" })
  });
  assert.equal(proximaChamadaMedica.response.status, 200);

  const segundaConsulta = await requestJson("/consulta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paciente: "Paciente Dois",
      cpf: "987.654.321-00",
      diagnostico: "Tosse",
      medicacao: "Paracetamol",
      triagemId: idsPorNome["Paciente Dois"]
    })
  });
  assert.equal(segundaConsulta.response.status, 201);

  const triagensAposConsultas = await requestJson("/triagens");
  assert.equal(
    triagensAposConsultas.data.some(item => item.status === "atendido"),
    false
  );
  assert.equal(
    triagensAposConsultas.data.some(item => String(item.id) === String(idsPorNome["Paciente Dois"])),
    false
  );

  const medicacoes = await requestJson("/medicacoes");
  assert.equal(medicacoes.data.length, 2);
  assert.deepEqual(
    medicacoes.data
      .map(({ paciente, cpf, medicacao }) => ({ paciente, cpf, medicacao }))
      .sort((a, b) => a.paciente.localeCompare(b.paciente)),
    [
      { paciente: "Paciente Dois", cpf: "98765432100", medicacao: "Paracetamol" },
      { paciente: "Paciente Um", cpf: "12345678900", medicacao: "Dipirona" }
    ]
  );

  const medicacaoPacienteUm = medicacoes.data.find(item => item.paciente === "Paciente Um");
  assert.equal(medicacaoPacienteUm.medicacaoRecebidaEm, undefined);
  const confirmacao = await requestJson(`/medicacoes/${medicacaoPacienteUm.id}/recebida`, {
    method: "POST"
  });
  assert.equal(confirmacao.response.status, 200);
  assert.ok(Number.isFinite(Date.parse(confirmacao.data.medicacaoRecebidaEm)));

  const medicacoesAtualizadas = await requestJson("/medicacoes");
  const pacienteUmAtualizado = medicacoesAtualizadas.data.find(item => item.paciente === "Paciente Um");
  assert.equal(pacienteUmAtualizado.medicacaoRecebidaEm, confirmacao.data.medicacaoRecebidaEm);
  const confirmacaoRepetida = await requestJson(`/medicacoes/${medicacaoPacienteUm.id}/recebida`, {
    method: "POST"
  });
  assert.equal(confirmacaoRepetida.data.medicacaoRecebidaEm, confirmacao.data.medicacaoRecebidaEm);

  const filaFinal = await requestJson("/dashboard-summary");
  assert.equal(filaFinal.data.stats.pacientesFila, 0);
});

test("gerencia estoque, registra movimentações e impede saldo negativo", async () => {
  const cadastroInvalido = await requestJson("/estoque", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: "Soro fisiológico",
      quantidade: 1.5,
      unidade: "frascos",
      categoria: "solução"
    })
  });
  assert.equal(cadastroInvalido.response.status, 400);

  const cadastro = await requestJson("/estoque", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: "Soro fisiológico",
      quantidade: 10,
      unidade: "frascos",
      categoria: "solução"
    })
  });
  assert.equal(cadastro.response.status, 201);
  assert.equal(cadastro.data.quantidade, 10);

  const duplicado = await requestJson("/estoque", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: "soro FISIOLOGICO",
      quantidade: 4,
      unidade: "frascos",
      categoria: "solução"
    })
  });
  assert.equal(duplicado.response.status, 409);

  const entrada = await requestJson(`/estoque/${cadastro.data.id}/movimentacoes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tipo: "entrada",
      quantidade: 5,
      observacao: "Nota fiscal NF-001"
    })
  });
  assert.equal(entrada.response.status, 200);
  assert.equal(entrada.data.medicamento.quantidade, 15);

  const remocaoExcessiva = await requestJson(`/estoque/${cadastro.data.id}/movimentacoes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo: "ajuste", quantidade: -16 })
  });
  assert.equal(remocaoExcessiva.response.status, 409);

  const exclusaoComSaldo = await requestJson(`/estoque/${cadastro.data.id}`, {
    method: "DELETE"
  });
  assert.equal(exclusaoComSaldo.response.status, 409);

  const ajuste = await requestJson(`/estoque/${cadastro.data.id}/movimentacoes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo: "ajuste", quantidade: -15 })
  });
  assert.equal(ajuste.response.status, 200);
  assert.equal(ajuste.data.medicamento.quantidade, 0);

  const exclusao = await requestJson(`/estoque/${cadastro.data.id}`, {
    method: "DELETE"
  });
  assert.equal(exclusao.response.status, 200);

  const estoqueFinal = await requestJson("/estoque");
  assert.equal(estoqueFinal.data.length, 0);
  const historico = await requestJson("/estoque/movimentacoes");
  assert.equal(historico.data.length, 4);
  assert.equal(historico.data.some(item => item.tipo === "exclusao"), true);
});

test("confirma acesso de paciente sem criar chamadas duplicadas na fila de triagem", async () => {
  const cadastro = await requestJson("/atendimento", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nome: "Paciente para triagem",
      cpf: "111.222.333-44",
      dataNascimento: "1990-01-01",
      sexo: "Prefiro não informar",
      nomeMae: "Responsável",
      estadoCivil: "Solteiro(a)",
      tipo: "Particular",
      telefone: "11999999999",
      contatoEmergencia: "11888888888",
      endereco: "Rua da Triagem"
    })
  });
  assert.equal(cadastro.response.status, 201);

  const filaAntesDaConfirmacao = await requestJson("/tv/chamada");
  const confirmacao = await requestJson("/atendimento/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cpf: "111.222.333-44", senha: "1234" })
  });
  assert.equal(confirmacao.response.status, 200);
  assert.equal(confirmacao.data.cadastroConfirmado, true);

  const filaDepoisDaConfirmacao = await requestJson("/tv/chamada");
  assert.equal(filaDepoisDaConfirmacao.data.chamada.id, filaAntesDaConfirmacao.data.chamada.id);
  assert.equal(filaDepoisDaConfirmacao.data.fila.length, filaAntesDaConfirmacao.data.fila.length);
  assert.equal(String(filaDepoisDaConfirmacao.data.chamada.pacienteId), String(cadastro.data.id));
});
