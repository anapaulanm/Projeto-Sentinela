const assert = require("node:assert/strict");
const express = require("express");
const { after, before, test } = require("node:test");
const { createStateStore } = require("./state-store");

class MemoryPool {
  constructor() {
    this.state = null;
    this.queries = [];
  }

  async connect() {
    const pool = this;
    let transactionState = null;

    return {
      async query(sql, values = []) {
        pool.queries.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
        if (sql === "BEGIN") transactionState = pool.state;
        if (sql.startsWith("INSERT INTO")) {
          transactionState = transactionState || JSON.parse(values[0]);
        }
        if (sql.startsWith("SELECT state")) {
          return { rows: [{ state: transactionState }] };
        }
        if (sql.startsWith("UPDATE public.oasis_state")) {
          transactionState = JSON.parse(values[0]);
        }
        if (sql === "COMMIT") pool.state = transactionState;
        if (sql === "ROLLBACK") transactionState = null;
        return { rows: [] };
      },
      release() {}
    };
  }
}

let server;
let baseUrl;
let pool;

before(async () => {
  pool = new MemoryPool();
  const store = createStateStore({
    databaseUrl: "postgres://test",
    defaultData: { counter: 0 },
    normalizeData: data => ({ db: data, changed: false }),
    pool
  });
  const app = express();
  app.use(store.middleware);
  app.get("/state", (req, res) => res.json(store.readDB()));
  app.post("/increment", (req, res) => {
    const db = store.readDB();
    db.counter += 1;
    store.writeDB(db);
    return res.json(db);
  });
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});

test("persiste alterações do estado no banco antes de responder", async () => {
  const update = await fetch(`${baseUrl}/increment`, { method: "POST" });
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), { counter: 1 });
  assert.deepEqual(pool.state, { counter: 1 });
  assert.equal(pool.queries.filter(query => query === "CREATE TABLE IF").length, 1);
  assert.ok(pool.queries.includes("COMMIT"));

  const read = await fetch(`${baseUrl}/state`);
  assert.deepEqual(await read.json(), { counter: 1 });
});

test("bloqueia a API quando o banco persistente não está configurado", async () => {
  const store = createStateStore({
    dbFile: "unused.json",
    requirePersistent: true,
    defaultData: {},
    normalizeData: data => ({ db: data, changed: false })
  });
  const app = express();
  app.use(store.middleware);
  app.get("/health", (req, res) => res.json({ ok: true }));
  const missingConfigServer = app.listen(0);
  await new Promise(resolve => missingConfigServer.once("listening", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${missingConfigServer.address().port}/health`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).erro, /DATABASE_URL/);
  } finally {
    await new Promise((resolve, reject) => {
      missingConfigServer.close(error => error ? reject(error) : resolve());
    });
  }
});
