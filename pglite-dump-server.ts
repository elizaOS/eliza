// Serve the pglite snapshot over the postgres wire protocol so native pg_dump
// can take a logical dump (pglite is WASM32; its datadir is binary-incompatible
// with native postgres, so logical is the only path).
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const db = await PGlite.create({
  dataDir: "/home/milady/iqlabs/pglite-snapshot",
  extensions: { vector, fuzzystrmatch },
});
const r = await db.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'");
console.log("pglite open; public tables:", (r.rows[0] as { n: unknown }).n);
const server = new PGLiteSocketServer({ db, port: 5434, host: "127.0.0.1" });
await server.start();
console.log("wire server on 127.0.0.1:5434 — ready for pg_dump");
