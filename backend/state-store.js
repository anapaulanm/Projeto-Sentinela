const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

function createStateStore({
  dbFile,
  databaseUrl,
  requirePersistent = false,
  defaultData,
  normalizeData,
  pool: suppliedPool
}) {
  const requestContext = new AsyncLocalStorage();
  let pool = suppliedPool || null;
  let schemaPromise = null;

  if (databaseUrl && !pool) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000
    });
  }

  function readDB() {
    const context = requestContext.getStore();
    if (context) return context.db;

    if (!fs.existsSync(dbFile)) {
      writeDB(defaultData);
      return JSON.parse(JSON.stringify(defaultData));
    }

    const raw = fs.readFileSync(dbFile, "utf8");
    const { db, changed } = normalizeData(JSON.parse(raw || "{}"));
    if (changed) writeDB(db);
    return db;
  }

  function writeDB(data) {
    const context = requestContext.getStore();
    if (context) {
      context.db = data;
      context.dirty = true;
      return;
    }

    const directory = path.dirname(dbFile);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
  }

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        const client = await pool.connect();
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS public.oasis_state (
              id SMALLINT PRIMARY KEY CHECK (id = 1),
              state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);
        } finally {
          client.release();
        }
      })();
    }

    try {
      await schemaPromise;
    } catch (error) {
      schemaPromise = null;
      throw error;
    }
  }

  async function rollback(client, reason) {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      console.error("Falha ao reverter transação do banco de dados.", error.message);
    } finally {
      client.release(reason);
    }
  }

  async function persistentMiddleware(req, res, next) {
    if (!pool) {
      if (requirePersistent) {
        console.error("DATABASE_URL não foi configurada para este ambiente hospedado.");
        return res.status(503).json({
          erro: "O banco persistente não está configurado. Defina DATABASE_URL para conectar ao PostgreSQL."
        });
      }
      return next();
    }

    let client;
    try {
      await ensureSchema();
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO public.oasis_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
        [JSON.stringify(defaultData)]
      );
      const result = await client.query(
        "SELECT state FROM public.oasis_state WHERE id = 1 FOR UPDATE"
      );
      if (!result.rows.length) {
        throw new Error("A linha de estado do Oasis não foi encontrada.");
      }

      const { db, changed } = normalizeData(result.rows[0].state);
      const context = {
        client,
        db,
        dirty: changed,
        finalizing: false
      };
      const sendJson = res.json.bind(res);

      res.json = function (body) {
        if (context.finalizing) return res;
        context.finalizing = true;

        void (async () => {
          try {
            if (context.dirty) {
              await client.query(
                "UPDATE public.oasis_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1",
                [JSON.stringify(context.db)]
              );
            }
            await client.query("COMMIT");
            client.release();
            sendJson(body);
          } catch (error) {
            console.error("Falha ao salvar dados no banco persistente.", error.message);
            await rollback(client, error);
            if (!res.headersSent) {
              res.statusCode = 503;
              sendJson({ erro: "Não foi possível salvar os dados no banco persistente." });
            } else {
              res.destroy(error);
            }
          }
        })();

        return res;
      };

      res.once("close", () => {
        if (context.finalizing) return;
        context.finalizing = true;
        void rollback(client);
      });

      return requestContext.run(context, next);
    } catch (error) {
      console.error("Falha ao abrir transação no banco persistente.", error.message);
      if (client) await rollback(client, error);
      return res.status(503).json({
        erro: "Não foi possível acessar o banco persistente. Verifique DATABASE_URL e a disponibilidade do PostgreSQL."
      });
    }
  }

  function middleware(req, res, next) {
    if (pool || requirePersistent) {
      return persistentMiddleware(req, res, next);
    }
    return next();
  }

  return { readDB, writeDB, middleware };
}

module.exports = { createStateStore };
