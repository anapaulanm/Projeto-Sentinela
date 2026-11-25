const express = require("express");
const path = require("path");
const cors = require("cors");
const { createStateStore } = require("./state-store");

const app = express();
const BASE_DIR = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(BASE_DIR, "frontend");
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "db.json");
const PORT = Number(process.env.PORT) || 3000;
const TIPOS_USUARIO = [
  "triagem",
  "medico",
  "atendimento",
  "tv",
  "medicacoes",
  "almoxarifado"
];

const DEFAULT_DB = {
  usuarios: [
    { usuario: "admin", senha: "1234", tipo: "admin" },
    { usuario: "triagem", senha: "1234", tipo: "triagem" },
    { usuario: "medico", senha: "1234", tipo: "medico" },
    { usuario: "atendimento", senha: "1234", tipo: "atendimento" },
    { usuario: "tv", senha: "1234", tipo: "tv" },
    { usuario: "medicacoes", senha: "1234", tipo: "medicacoes" },
    { usuario: "almoxarifado", senha: "1234", tipo: "almoxarifado" }
  ],
  pacientes: [],
  triagens: [],
  consultas: [],
  chamadas: [],
  estoque: [],
  movimentacoesEstoque: []
};

app.use(express.json());
app.use(cors());
app.use(express.static(FRONTEND_DIR));

function normalizarEstadoChamadas(db) {
  if (!db || !Array.isArray(db.chamadas)) return false;

  let mudou = false;
  const ativas = db.chamadas.filter(chamada => chamada.status === "ativa");
  if (ativas.length > 1) {
    db.chamadas.forEach(chamada => {
      if (chamada.status === "ativa" && String(chamada.id) !== String(ativas[0].id)) {
        chamada.status = "concluida";
        chamada.concluidaEm = new Date().toISOString();
        mudou = true;
      }
    });
  }

  db.chamadas.forEach(chamada => {
    if (chamada.status !== "ativa") return;

    const base = chamada.chamadaEm || chamada.createdAt || chamada.id;
    const timestamp = new Date(base).getTime();
    const expirou = Number.isFinite(timestamp) && (Date.now() - timestamp) > 15 * 60 * 1000;
    const chamadaConsultaSemTriagem = chamada.localTipo === "CONSULTA" &&
      (!chamada.triagemId || !db.triagens.some(triagem => String(triagem.id) === String(chamada.triagemId)));

    if (expirou || chamadaConsultaSemTriagem) {
      chamada.status = "concluida";
      chamada.concluidaEm = new Date().toISOString();
      mudou = true;
    }
  });

  db.tvAguardandoProximoPaciente = !db.chamadas.some(chamada => chamada.status === "ativa");
  return mudou;
}

function normalizeDBData(data) {
  const db = {
    usuarios: Array.isArray(data.usuarios) ? data.usuarios : [],
    pacientes: Array.isArray(data.pacientes) ? data.pacientes : [],
    triagens: Array.isArray(data.triagens) ? data.triagens : [],
    consultas: Array.isArray(data.consultas) ? data.consultas : [],
    chamadas: Array.isArray(data.chamadas)
      ? data.chamadas
      : [
        ...(Array.isArray(data.pacientes) ? data.pacientes : []).map(paciente => ({
          id: `historico-triagem-${paciente.id}`,
          pacienteId: paciente.id,
          nome: paciente.nome,
          localTipo: "TRIAGEM",
          status: "concluida",
          createdAt: paciente.createdAt || paciente.id
        })),
        ...(Array.isArray(data.triagens) ? data.triagens : []).map(triagem => ({
          id: `historico-consulta-${triagem.id}`,
          triagemId: triagem.id,
          nome: triagem.nome,
          localTipo: "CONSULTA",
          status: "concluida",
          createdAt: triagem.createdAt || triagem.id
        }))
      ],
    estoque: Array.isArray(data.estoque) ? data.estoque : [],
    movimentacoesEstoque: Array.isArray(data.movimentacoesEstoque)
      ? data.movimentacoesEstoque
      : [],
    tvAguardandoProximoPaciente: Boolean(data.tvAguardandoProximoPaciente)
  };

  let changed = false;
  if (!db.usuarios.some(usuario => usuario.usuario === "admin")) {
    db.usuarios.push({ usuario: "admin", senha: "1234", tipo: "admin" });
    changed = true;
  }
  changed = normalizarEstadoChamadas(db) || changed;
  return { db, changed };
}

const stateStore = createStateStore({
  dbFile: DB_FILE,
  databaseUrl: process.env.DB_FILE ? null : process.env.DATABASE_URL,
  requirePersistent: (process.env.VERCEL === "1" || process.env.RENDER === "true") &&
    !process.env.DB_FILE,
  defaultData: DEFAULT_DB,
  normalizeData: normalizeDBData
});
const { readDB, writeDB } = stateStore;
app.use(stateStore.middleware);

function nextId(items) {
  const highestId = items.reduce((highest, item) => {
    const id = Number(item.id);
    return Number.isFinite(id) ? Math.max(highest, id) : highest;
  }, 0);
  return Math.max(Date.now(), highestId + 1);
}

function normalizarNomeEstoque(nome) {
  return nome.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function registrarMovimentacaoEstoque(db, medicamento, dados) {
  const movimentacao = {
    id: nextId(db.movimentacoesEstoque),
    estoqueId: medicamento.id,
    medicamento: medicamento.nome,
    unidade: medicamento.unidade,
    tipo: dados.tipo,
    quantidade: dados.quantidade,
    saldoAnterior: dados.saldoAnterior,
    saldoAtual: dados.saldoAtual,
    observacao: dados.observacao || "",
    responsavel: dados.responsavel || "Almoxarifado",
    createdAt: new Date().toISOString()
  };
  db.movimentacoesEstoque.push(movimentacao);
  return movimentacao;
}

function inferirRisco(sintoma, temperatura) {
  if (Number.isFinite(temperatura) && temperatura >= 39) {
    return "vermelho";
  }

  const sintomas = (Array.isArray(sintoma) ? sintoma : [sintoma])
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
  if (/\binfarto\b|\bavc\b|\bconvuls|\bhemorrag|\bfalta de ar grave\b|\bfalta_ar_grave\b/.test(sintomas)) {
    return "vermelho";
  }
  if (/\bfebre\b|\bvomit|\bdiarre|\bfalta de ar moderada\b|\bfalta_ar_moderada\b/.test(sintomas)) {
    return "amarelo";
  }

  return "verde";
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/login", (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const usuario = String(body.usuario || "").trim();
  const senha = String(body.senha || "").trim();

  const user = db.usuarios.find(u =>
    u.usuario === usuario && u.senha === senha
  );

  if (!user) {
    return res.status(401).json({ erro: "Login inválido" });
  }

  return res.json({ usuario: user.usuario, tipo: user.tipo });
});

app.get("/usuarios", (req, res) => {
  const db = readDB();
  return res.json(db.usuarios.map(({ usuario, tipo }) => ({ usuario, tipo })));
});

app.post("/usuarios", (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const usuario = String(body.usuario || "").trim();
  const senha = String(body.senha || "").trim();
  const tipo = String(body.tipo || "").trim();

  if (!usuario || !senha || !TIPOS_USUARIO.includes(tipo)) {
    return res.status(400).json({ erro: "Usuário, senha e setor válido são obrigatórios." });
  }
  if (db.usuarios.some(user => user.usuario.toLowerCase() === usuario.toLowerCase())) {
    return res.status(409).json({ erro: "Esse nome de usuário já está cadastrado." });
  }

  const user = { usuario, senha, tipo };
  db.usuarios.push(user);
  writeDB(db);
  return res.status(201).json({ usuario: user.usuario, tipo: user.tipo });
});

app.get("/dashboard-summary", (req, res) => {
  const db = readDB();
  const today = new Date();
  const dateKey = date => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  const todayKey = dateKey(today);
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - 6 + index);
    return { key: dateKey(date), label: date.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", ""), triagens: 0, consultas: 0 };
  });
  const byDate = new Map(week.map(day => [day.key, day]));
  const pacientesEmFila = new Set(
    db.chamadas
      .filter(chamada => ["ativa", "pendente"].includes(chamada.status))
      .map(chamada => String(chamada.pacienteId || chamada.triagemId || chamada.id))
  );

  db.triagens.forEach(triagem => {
    const timestamp = new Date(triagem.createdAt || triagem.id);
    if (!Number.isNaN(timestamp.getTime())) {
      const day = byDate.get(dateKey(timestamp));
      if (day) day.triagens += 1;
    }
  });
  db.consultas.forEach(consulta => {
    const timestamp = new Date(consulta.createdAt || consulta.id);
    if (!Number.isNaN(timestamp.getTime())) {
      const day = byDate.get(dateKey(timestamp));
      if (day) day.consultas += 1;
    }
  });

  const riscos = { vermelho: 0, amarelo: 0, verde: 0 };
  db.triagens.forEach(triagem => {
    if (Object.prototype.hasOwnProperty.call(riscos, triagem.risco)) {
      riscos[triagem.risco] += 1;
    }
  });

  return res.json({
    stats: {
      usuarios: db.usuarios.length,
      pacientesFila: pacientesEmFila.size,
      triagensHoje: db.triagens.filter(triagem => {
        const timestamp = new Date(triagem.createdAt || triagem.id);
        return !Number.isNaN(timestamp.getTime()) && dateKey(timestamp) === todayKey;
      }).length,
      consultas: db.consultas.length
    },
    semana: week.map(({ key, ...day }) => day),
    riscos
  });
});

function normalizarCpf(cpf) {
  return String(cpf || "").replace(/\D/g, "");
}

function calcularIdade(dataNascimento) {
  const nascimento = new Date(`${dataNascimento}T00:00:00`);
  if (!dataNascimento || Number.isNaN(nascimento.getTime())) return null;
  const hoje = new Date();
  let idade = hoje.getFullYear() - nascimento.getFullYear();
  if (
    hoje.getMonth() < nascimento.getMonth() ||
    (hoje.getMonth() === nascimento.getMonth() && hoje.getDate() < nascimento.getDate())
  ) {
    idade -= 1;
  }
  return idade;
}

function registrarChamadaTriagem(db, paciente) {
  const chamadaPendente = db.chamadas.find(chamada =>
    String(chamada.pacienteId) === String(paciente.id) &&
    chamada.localTipo === "TRIAGEM" &&
    ["pendente", "ativa"].includes(chamada.status)
  );
  if (chamadaPendente) {
    if (chamadaPendente.status === "pendente") {
      ativarPrimeiraTriagem(db);
    }
    return chamadaPendente;
  }

  const chamada = {
    id: nextId(db.chamadas),
    pacienteId: paciente.id,
    nome: paciente.nome,
    localTipo: "TRIAGEM",
    status: "pendente",
    numero: db.chamadas.length + 1,
    createdAt: new Date().toISOString()
  };
  db.chamadas.push(chamada);
  ativarPrimeiraTriagem(db);
  return chamada;
}

function prioridadeRisco(risco) {
  return { vermelho: 3, amarelo: 2, verde: 1 }[risco] || 0;
}

function ordenarChamadasPendentes(chamadas, etapa) {
  return chamadas
    .filter(chamada => chamada.status === "pendente" && (!etapa || chamada.localTipo === etapa))
    .sort((a, b) => {
      if (etapa === "CONSULTA") {
        const prioridade = prioridadeRisco(b.risco) - prioridadeRisco(a.risco);
        if (prioridade) return prioridade;
      }
      const diferenca = new Date(a.createdAt || a.id).getTime() -
        new Date(b.createdAt || b.id).getTime();
      return diferenca || String(a.id).localeCompare(String(b.id));
    });
}

function ativarPrimeiraTriagem(db) {
  if (db.chamadas.some(chamada => chamada.status === "ativa")) return;
  const proxima = ordenarChamadasPendentes(db.chamadas, "TRIAGEM")[0];
  if (!proxima) return;
  proxima.status = "ativa";
  proxima.chamadaEm = new Date().toISOString();
  db.tvAguardandoProximoPaciente = false;
}

function ativarProximaChamada(db, etapa) {
  const ativa = db.chamadas.find(chamada => chamada.status === "ativa");
  if (ativa && String(ativa.localTipo) !== String(etapa)) {
    return { erro: "Finalize a chamada atual antes de chamar outro paciente.", status: 409 };
  }
  if (ativa && String(ativa.localTipo) === String(etapa)) {
    return { erro: "Finalize a chamada atual antes de chamar outro paciente.", status: 409 };
  }
  const proxima = ordenarChamadasPendentes(db.chamadas, etapa)[0];
  if (!proxima) {
    return { erro: "Não há pacientes aguardando nessa fila.", status: 404 };
  }
  proxima.status = "ativa";
  proxima.chamadaEm = new Date().toISOString();
  db.tvAguardandoProximoPaciente = false;
  return { chamada: proxima };
}

function registrarChamadaConsulta(db, triagem) {
  const existente = db.chamadas.find(chamada =>
    String(chamada.triagemId) === String(triagem.id) &&
    chamada.localTipo === "CONSULTA" &&
    ["pendente", "ativa"].includes(chamada.status)
  );
  if (existente) return existente;

  const chamada = {
    id: nextId(db.chamadas),
    pacienteId: triagem.pacienteId || null,
    triagemId: triagem.id,
    nome: triagem.nome,
    localTipo: "CONSULTA",
    risco: triagem.risco,
    status: "pendente",
    numero: db.chamadas.length + 1,
    createdAt: new Date().toISOString()
  };
  db.chamadas.push(chamada);
  return chamada;
}

function concluirChamadaTriagem(db, triagem) {
  const chamada = db.chamadas.find(item =>
    item.localTipo === "TRIAGEM" &&
    item.status === "ativa" &&
    (triagem.pacienteId
      ? String(item.pacienteId) === String(triagem.pacienteId)
      : String(item.nome || "").trim().toLocaleLowerCase("pt-BR") ===
        String(triagem.nome || "").trim().toLocaleLowerCase("pt-BR"))
  );
  if (!chamada) return false;

  chamada.status = "concluida";
  chamada.concluidaEm = new Date().toISOString();
  triagem.pacienteId = chamada.pacienteId || null;
  triagem.chamadaTriagemId = chamada.id;
  db.tvAguardandoProximoPaciente = true;
  return true;
}

app.post("/atendimento", (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const nome = String(body.nome || "").trim();
  const cpf = String(body.cpf || "").trim();
  const tipo = String(body.tipo || "Particular").trim() || "Particular";
  const dataNascimento = String(body.dataNascimento || "").trim();
  const idade = calcularIdade(dataNascimento);

  if (!nome || !normalizarCpf(cpf) || idade === null || idade < 0) {
    return res.status(400).json({ erro: "Informe nome, CPF e uma data de nascimento válida." });
  }
  const cpfNormalizado = normalizarCpf(cpf);
  if (db.pacientes.some(paciente => normalizarCpf(paciente.cpf) === cpfNormalizado)) {
    return res.status(409).json({ erro: "Este CPF já tem cadastro. Use a opção de acesso." });
  }
  if (
    !body.sexo || !body.telefone || !body.contatoEmergencia || !body.endereco ||
    !["Convenio", "Particular"].includes(tipo) ||
    (idade < 18 && !String(body.responsaveis || "").trim()) ||
    (idade >= 18 && (!String(body.nomeMae || "").trim() || !String(body.estadoCivil || "").trim()))
  ) {
    return res.status(400).json({ erro: "Preencha todos os campos obrigatórios para a idade do paciente." });
  }

  const paciente = {
    id: nextId(db.pacientes),
    nome,
    cpf: cpfNormalizado,
    tipo,
    dataNascimento,
    sexo: String(body.sexo || "").trim(),
    nomeMae: String(body.nomeMae || "").trim(),
    responsaveis: String(body.responsaveis || "").trim(),
    estadoCivil: String(body.estadoCivil || "").trim(),
    endereco: String(body.endereco || "").trim(),
    telefone: String(body.telefone || "").trim(),
    email: String(body.email || "").trim(),
    contatoEmergencia: String(body.contatoEmergencia || "").trim(),
    status: "triagem",
    createdAt: new Date().toISOString()
  };

  db.pacientes.push(paciente);
  registrarChamadaTriagem(db, paciente);
  writeDB(db);

  return res.status(201).json(paciente);
});

app.post("/atendimento/login", (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const cpf = normalizarCpf(body.cpf);
  const senha = String(body.senha || "").trim();
  const paciente = db.pacientes.find(item => normalizarCpf(item.cpf) === cpf);

  if (!cpf || senha !== "1234" || !paciente) {
    return res.status(401).json({ erro: "CPF ou senha inválidos. A senha de acesso é 1234." });
  }

  return res.json({ paciente: paciente.nome, cadastroConfirmado: true });
});

app.post("/tv/chamar-proximo", (req, res) => {
  const etapa = String((req.body || {}).etapa || "").trim().toUpperCase();
  if (!["TRIAGEM", "CONSULTA"].includes(etapa)) {
    return res.status(400).json({ erro: "Informe uma fila válida para a chamada." });
  }

  const db = readDB();
  const resultado = ativarProximaChamada(db, etapa);
  if (resultado.erro) {
    return res.status(resultado.status).json({ erro: resultado.erro });
  }
  writeDB(db);
  const paciente = db.pacientes.find(item =>
    String(item.id) === String(resultado.chamada.pacienteId)
  );
  return res.json({
    chamada: {
      ...resultado.chamada,
      idade: paciente ? calcularIdade(paciente.dataNascimento) : null
    }
  });
});

app.post("/triagem", (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const pacienteId = body.pacienteId;
  const chamadaAtiva = db.chamadas.find(chamada =>
    chamada.status === "ativa" &&
    chamada.localTipo === "TRIAGEM" &&
    (!pacienteId || String(chamada.pacienteId) === String(pacienteId))
  );
  if (!chamadaAtiva) {
    return res.status(409).json({ erro: "Não há paciente chamado para triagem." });
  }

  const nome = chamadaAtiva.nome || String(body.nome || "").trim();
  const sintomas = Array.isArray(body.sintomas)
    ? body.sintomas.map(sintoma => String(sintoma || "").trim()).filter(Boolean)
    : String(body.sintoma || "").split(",").map(sintoma => sintoma.trim()).filter(Boolean);
  const sintoma = sintomas.join(", ");
  const temperaturaRaw = body.temperatura;
  const temperatura = temperaturaRaw === undefined || temperaturaRaw === null || temperaturaRaw === ""
    ? null
    : Number(temperaturaRaw);
  const alergia = String(body.alergia || "").trim();
  const observacao = String(body.observacao || "").trim();
  const pressao = String(body.pressao || "").trim();
  const alturaRaw = body.altura;
  const altura = alturaRaw === undefined || alturaRaw === null || alturaRaw === "" ? null : Number(alturaRaw);
  const pesoRaw = body.peso;
  const peso = pesoRaw === undefined || pesoRaw === null || pesoRaw === "" ? null : Number(pesoRaw);

  if (!nome) {
    return res.status(400).json({ erro: "Nome do paciente é obrigatório." });
  }
  if (
    (temperatura !== null && !Number.isFinite(temperatura)) ||
    (altura !== null && (!Number.isFinite(altura) || altura <= 0)) ||
    (peso !== null && (!Number.isFinite(peso) || peso <= 0))
  ) {
    return res.status(400).json({ erro: "Confira temperatura, altura e peso informados." });
  }

  const triagem = {
    id: nextId(db.triagens),
    pacienteId: chamadaAtiva.pacienteId || null,
    nome,
    sintoma,
    sintomas,
    temperatura,
    alergia,
    pressao,
    altura,
    peso,
    observacao,
    risco: inferirRisco(sintoma, temperatura),
    status: "aguardando_medico",
    createdAt: new Date().toISOString()
  };

  concluirChamadaTriagem(db, triagem);
  const pacienteTriado = db.pacientes.find(item =>
    String(item.id) === String(triagem.pacienteId)
  );
  if (pacienteTriado) pacienteTriado.status = "aguardando_medico";
  db.triagens.push(triagem);
  registrarChamadaConsulta(db, triagem);
  const resultadoProximaChamada = ativarProximaChamada(db, "TRIAGEM");
  const proximoPaciente = resultadoProximaChamada.chamada
    ? db.pacientes.find(item =>
      String(item.id) === String(resultadoProximaChamada.chamada.pacienteId)
    )
    : null;
  writeDB(db);

  return res.status(201).json({
    triagem,
    proximaChamada: resultadoProximaChamada.chamada
      ? {
        ...resultadoProximaChamada.chamada,
        idade: proximoPaciente ? calcularIdade(proximoPaciente.dataNascimento) : null
      }
      : null
  });
});

app.get("/triagens", (req, res) => {
  const db = readDB();
  const triagens = db.triagens.filter(triagem => triagem.status !== "atendido").sort((a, b) => {
    const prioridade = prioridadeRisco(b.risco) - prioridadeRisco(a.risco);
    if (prioridade) return prioridade;
    const aValue = new Date(a.createdAt || a.id || 0).getTime();
    const bValue = new Date(b.createdAt || b.id || 0).getTime();
    return aValue - bValue;
  });

  return res.json(triagens.map(triagem => {
    const paciente = db.pacientes.find(item =>
      String(item.id) === String(triagem.pacienteId)
    );
    return {
      ...triagem,
      cpf: paciente && paciente.cpf ? paciente.cpf : triagem.cpf || "",
      idade: paciente ? calcularIdade(paciente.dataNascimento) : triagem.idade ?? null
    };
  }));
});

app.get("/lista-medicacoes", (req, res) => {
  return res.json([
    "Dipirona",
    "Paracetamol",
    "Ibuprofeno",
    "Amoxicilina",
    "Azitromicina",
    "Loratadina",
    "Omeprazol",
    "Buscopan",
    "Dramin",
    "Soro fisiológico"
  ]);
});

app.post("/consulta", (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const paciente = String(body.paciente || "").trim();
  const diagnostico = String(body.diagnostico || "").trim();
  const medicacao = String(body.medicacao || "").trim();
  const triagemId = body.triagemId;

  if (!paciente || !diagnostico || !medicacao) {
    return res.status(400).json({ erro: "Paciente, diagnóstico e medicação são obrigatórios." });
  }
  const triagem = triagemId === undefined
    ? null
    : db.triagens.find(item => String(item.id) === String(triagemId));
  if (triagemId !== undefined && !triagem) {
    return res.status(404).json({ erro: "A triagem selecionada não foi encontrada." });
  }
  if (triagem && triagem.status === "atendido") {
    return res.status(409).json({ erro: "Essa triagem já foi atendida." });
  }
  const chamadaConsulta = triagem
    ? db.chamadas.find(chamada =>
      String(chamada.triagemId) === String(triagem.id) &&
      chamada.localTipo === "CONSULTA" &&
      chamada.status === "ativa"
    )
    : null;
  if (triagem && !chamadaConsulta) {
    return res.status(409).json({ erro: "Chame o paciente para consulta antes de finalizar o atendimento." });
  }

  const consulta = {
    id: nextId(db.consultas),
    paciente,
    pacienteId: triagem ? triagem.pacienteId || null : null,
    triagemId: triagem ? triagem.id : null,
    cpf: triagem
      ? (db.pacientes.find(item => String(item.id) === String(triagem.pacienteId)) || {}).cpf ||
        triagem.cpf || String(body.cpf || "").trim()
      : String(body.cpf || "").trim(),
    diagnostico,
    medicacao,
    createdAt: new Date().toISOString()
  };

  db.consultas.push(consulta);
  if (triagem) {
    triagem.status = "atendido";
    triagem.consultaId = consulta.id;
    const paciente = db.pacientes.find(item =>
      String(item.id) === String(triagem.pacienteId)
    );
    if (paciente) paciente.status = "atendido";
    chamadaConsulta.status = "concluida";
    chamadaConsulta.concluidaEm = consulta.createdAt;
    db.tvAguardandoProximoPaciente = true;
  }
  writeDB(db);

  return res.status(201).json(consulta);
});

app.post("/medicacoes/:id/recebida", (req, res) => {
  const db = readDB();
  const consulta = db.consultas.find(item => String(item.id) === String(req.params.id));
  if (!consulta || !String(consulta.medicacao || "").trim()) {
    return res.status(404).json({ erro: "A medicação prescrita não foi encontrada." });
  }

  if (!consulta.medicacaoRecebidaEm) {
    consulta.medicacaoRecebidaEm = new Date().toISOString();
    writeDB(db);
  }

  return res.json(consulta);
});

app.get("/medicacoes", (req, res) => {
  const db = readDB();
  const consultas = db.consultas
    .filter(consulta =>
      String(consulta.paciente || "").trim() &&
      String(consulta.medicacao || "").trim()
    )
    .sort((a, b) =>
    new Date(b.createdAt || b.id || 0).getTime() -
    new Date(a.createdAt || a.id || 0).getTime()
  );
  return res.json(consultas.map(consulta => {
    const triagem = db.triagens.find(item =>
      String(item.id) === String(consulta.triagemId)
    );
    const pacienteId = consulta.pacienteId || (triagem && triagem.pacienteId);
    const paciente = db.pacientes.find(item =>
      String(item.id) === String(pacienteId)
    ) || db.pacientes.find(item =>
      item.nome && item.nome.trim().toLocaleLowerCase("pt-BR") ===
        String(consulta.paciente || "").trim().toLocaleLowerCase("pt-BR")
    );
    return {
      ...consulta,
      cpf: paciente && paciente.cpf ? paciente.cpf : consulta.cpf || ""
    };
  }));
});

app.get("/estoque", (req, res) => {
  const db = readDB();
  const estoque = [...db.estoque].sort((a, b) =>
    String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR")
  );
  res.set("Cache-Control", "no-store");
  return res.json(estoque);
});

app.get("/estoque/movimentacoes", (req, res) => {
  const db = readDB();
  const movimentacoes = [...db.movimentacoesEstoque]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);
  res.set("Cache-Control", "no-store");
  return res.json(movimentacoes);
});

app.post("/estoque", (req, res) => {
  const db = readDB();
  const body = req.body || {};
  const nome = String(body.nome || "").trim();
  const quantidade = Number(body.quantidade);
  const unidade = String(body.unidade || "unidades").trim();
  const categoria = String(body.categoria || "geral").trim();

  if (!nome || nome.length > 120 || !unidade || unidade.length > 40 ||
      !categoria || categoria.length > 80 ||
      !Number.isSafeInteger(quantidade) || quantidade <= 0) {
    return res.status(400).json({
      erro: "Informe nome, unidade, categoria e uma quantidade inteira maior que zero."
    });
  }

  const nomeNormalizado = normalizarNomeEstoque(nome);
  if (db.estoque.some(item => normalizarNomeEstoque(String(item.nome || "")) === nomeNormalizado)) {
    return res.status(409).json({
      erro: "Já existe um medicamento com esse nome. Use a opção de reposição."
    });
  }

  const agora = new Date().toISOString();
  const medicamento = {
    id: nextId(db.estoque),
    nome,
    quantidade,
    unidade,
    categoria,
    createdAt: agora,
    updatedAt: agora
  };
  db.estoque.push(medicamento);
  registrarMovimentacaoEstoque(db, medicamento, {
    tipo: "entrada",
    quantidade,
    saldoAnterior: 0,
    saldoAtual: quantidade,
    observacao: "Cadastro inicial",
    responsavel: String(body.responsavel || "Almoxarifado").trim().slice(0, 80)
  });
  writeDB(db);
  return res.status(201).json(medicamento);
});

app.post("/estoque/:id/movimentacoes", (req, res) => {
  const db = readDB();
  const medicamento = db.estoque.find(item => String(item.id) === String(req.params.id));
  if (!medicamento) {
    return res.status(404).json({ erro: "O medicamento não foi encontrado no estoque." });
  }

  const body = req.body || {};
  const tipo = String(body.tipo || "");
  const quantidadeInformada = Number(body.quantidade);
  if (!["entrada", "saida", "ajuste"].includes(tipo) ||
      !Number.isSafeInteger(quantidadeInformada) || quantidadeInformada === 0 ||
      (tipo === "entrada" && quantidadeInformada < 0) ||
      (tipo === "saida" && quantidadeInformada <= 0)) {
    return res.status(400).json({ erro: "Informe um tipo de movimentação e uma quantidade inteira válida." });
  }

  const variacao = tipo === "saida" ? -quantidadeInformada : quantidadeInformada;
  const saldoAnterior = Number(medicamento.quantidade);
  const saldoAtual = saldoAnterior + variacao;
  if (!Number.isSafeInteger(saldoAtual) || saldoAtual < 0) {
    return res.status(409).json({ erro: "A movimentação não pode deixar o estoque negativo." });
  }

  const observacao = String(body.observacao || "").trim();
  if (observacao.length > 300) {
    return res.status(400).json({ erro: "A observação deve ter no máximo 300 caracteres." });
  }

  medicamento.quantidade = saldoAtual;
  medicamento.updatedAt = new Date().toISOString();
  const movimentacao = registrarMovimentacaoEstoque(db, medicamento, {
    tipo,
    quantidade: variacao,
    saldoAnterior,
    saldoAtual,
    observacao,
    responsavel: String(body.responsavel || "Almoxarifado").trim().slice(0, 80)
  });
  writeDB(db);
  return res.json({ medicamento, movimentacao });
});

app.delete("/estoque/:id", (req, res) => {
  const db = readDB();
  const indice = db.estoque.findIndex(item => String(item.id) === String(req.params.id));
  if (indice === -1) {
    return res.status(404).json({ erro: "O medicamento não foi encontrado no estoque." });
  }

  const medicamento = db.estoque[indice];
  if (Number(medicamento.quantidade) !== 0) {
    return res.status(409).json({
      erro: "Só é possível remover medicamentos com estoque zerado."
    });
  }

  registrarMovimentacaoEstoque(db, medicamento, {
    tipo: "exclusao",
    quantidade: 0,
    saldoAnterior: 0,
    saldoAtual: 0,
    observacao: "Medicamento removido do cadastro",
    responsavel: "Almoxarifado"
  });
  db.estoque.splice(indice, 1);
  writeDB(db);
  return res.json({ mensagem: "Medicamento removido do cadastro." });
});

app.get("/tv/chamada", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  const db = readDB();
  const ativa = db.chamadas.find(chamada => chamada.status === "ativa") || null;
  const detalhesPaciente = chamada => {
    const paciente = db.pacientes.find(item =>
      String(item.id) === String(chamada.pacienteId)
    );
    return {
      id: chamada.id,
      pacienteId: chamada.pacienteId || null,
      triagemId: chamada.triagemId || null,
      localTipo: chamada.localTipo,
      localNumero: String(chamada.numero || 1).padStart(2, "0"),
      paciente: chamada.nome,
      idade: paciente ? calcularIdade(paciente.dataNascimento) : null,
      risco: chamada.risco || null,
      chamadaEm: chamada.chamadaEm || null
    };
  };
  const historico = db.chamadas
    .filter(chamada => chamada.nome && ["ativa", "concluida"].includes(chamada.status))
    .sort((a, b) => new Date(b.chamadaEm || b.concluidaEm || b.createdAt).getTime() -
      new Date(a.chamadaEm || a.concluidaEm || a.createdAt).getTime())
    .slice(0, 4)
    .map(detalhesPaciente);
  const fila = [
    ...ordenarChamadasPendentes(db.chamadas, "TRIAGEM"),
    ...ordenarChamadasPendentes(db.chamadas, "CONSULTA")
  ].slice(0, 8).map(chamada => ({
    ...detalhesPaciente(chamada),
    aguardando: true
  }));
  const proxima = fila[0] || null;

  return res.json({
    chamada: ativa ? detalhesPaciente(ativa) : null,
    proxima,
    aguardandoProximoPaciente: db.tvAguardandoProximoPaciente,
    historico,
    fila
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ erro: "Erro interno do servidor." });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🏥 Hospital Pro rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;