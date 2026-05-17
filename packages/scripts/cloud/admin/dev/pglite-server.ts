#!/usr/bin/env bun

/**
 * PGlite TCP server for local development.
 *
 * Boots an embedded PGlite instance with pgvector and exposes it on a
 * Postgres-compatible TCP socket so the wrangler/Miniflare API and any other
 * `pg`-style consumer can connect with no Docker. One process per workspace.
 *
 *   bun run pglite:server                              # default :5432, .eliza/.pgdata
 *   PGLITE_PORT=55432 bun run pglite:server
 *   PGLITE_DATA_DIR=/tmp/eliza-pglite bun run pglite:server
 *   PGLITE_IN_MEMORY=1 bun run pglite:server
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number.parseInt(process.env.PGLITE_PORT ?? "5432", 10);
const HOST = process.env.PGLITE_HOST ?? "127.0.0.1";
const MAX_CONNECTIONS = Number.parseInt(process.env.PGLITE_MAX_CONNECTIONS ?? "16", 10);
const DATA_DIR =
  process.env.PGLITE_IN_MEMORY === "1"
    ? undefined
    : path.resolve(process.cwd(), process.env.PGLITE_DATA_DIR ?? ".eliza/.pgdata");

const tag = "[pglite]";

if (DATA_DIR) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = await PGlite.create({
  dataDir: DATA_DIR,
  extensions: { vector },
});

const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: HOST,
  maxConnections: MAX_CONNECTIONS,
  debug: process.env.PGLITE_DEBUG === "1",
  inspect: process.env.PGLITE_INSPECT === "1",
});

await server.start();

console.log(
  `${tag} listening on ${HOST}:${PORT} (${DATA_DIR ? `data: ${DATA_DIR}` : "in-memory"})`,
);
console.log(`${tag} max connections: ${MAX_CONNECTIONS}`);
console.log(`${tag} DATABASE_URL=postgresql://postgres@${HOST}:${PORT}/postgres`);

async function shutdown(signal: string) {
  console.log(`${tag} ${signal} — closing server`);
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
