#!/usr/bin/env bun

/**
 * PGlite TCP server for local development.
 *
 * Boots an embedded PGlite instance with the production migration extensions
 * (including pgvector) and exposes it on a Postgres-compatible TCP socket so
 * the wrangler/Miniflare API and other `pg`-style consumers can connect with no
 * Docker. One process runs per workspace; managed harnesses can require an
 * ownership marker before accepting the socket as their own.
 *
 *   bun run pglite:server                              # default :5432, .eliza/.pgdata
 *   PGLITE_PORT=55432 bun run pglite:server
 *   PGLITE_DATA_DIR=/tmp/eliza-pglite bun run pglite:server
 *   PGLITE_IN_MEMORY=1 bun run pglite:server
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const PORT = Number.parseInt(process.env.PGLITE_PORT ?? "5432", 10);
const HOST = process.env.PGLITE_HOST ?? "127.0.0.1";
const MAX_CONNECTIONS = Number.parseInt(
  process.env.PGLITE_MAX_CONNECTIONS ?? "16",
  10,
);
const DATA_DIR =
  process.env.PGLITE_IN_MEMORY === "1"
    ? undefined
    : path.resolve(
        process.cwd(),
        process.env.PGLITE_DATA_DIR ?? ".eliza/.pgdata",
      );
const READY_FILE = process.env.PGLITE_READY_FILE?.trim();
const OWNER_TOKEN = process.env.PGLITE_OWNER_TOKEN?.trim();
const RUN_ID = process.env.PGLITE_RUN_ID?.trim();

if (
  new Set([Boolean(READY_FILE), Boolean(OWNER_TOKEN), Boolean(RUN_ID)]).size !==
  1
) {
  throw new Error(
    "PGLITE_READY_FILE, PGLITE_OWNER_TOKEN, and PGLITE_RUN_ID must be configured together",
  );
}

const tag = "[pglite]";

if (DATA_DIR) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
const [{ PGlite }, { btree_gist }, { vector }, { PGLiteSocketServer }] =
  await Promise.all([
    import(requireFromCwd.resolve("@electric-sql/pglite")),
    import(requireFromCwd.resolve("@electric-sql/pglite/contrib/btree_gist")),
    import(requireFromCwd.resolve("@electric-sql/pglite/vector")),
    import(requireFromCwd.resolve("@electric-sql/pglite-socket")),
  ]);

const db = await PGlite.create({
  dataDir: DATA_DIR,
  extensions: { btree_gist, vector },
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

if (READY_FILE && OWNER_TOKEN && RUN_ID) {
  const readyPath = path.resolve(READY_FILE);
  const temporaryReadyPath = `${readyPath}.${process.pid}.${OWNER_TOKEN}.tmp`;
  mkdirSync(path.dirname(readyPath), { recursive: true });
  writeFileSync(
    temporaryReadyPath,
    `${JSON.stringify({
      ownerToken: OWNER_TOKEN,
      runId: RUN_ID,
      pid: process.pid,
      host: HOST,
      port: PORT,
      dataDir: DATA_DIR ?? null,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporaryReadyPath, readyPath);
}

console.log(
  `${tag} listening on ${HOST}:${PORT} (${DATA_DIR ? `data: ${DATA_DIR}` : "in-memory"})`,
);
console.log(`${tag} max connections: ${MAX_CONNECTIONS}`);
console.log(
  `${tag} DATABASE_URL=postgresql://postgres@${HOST}:${PORT}/postgres`,
);

async function shutdown(signal: string) {
  console.log(`${tag} ${signal} — closing server`);
  // error-policy:J6 best-effort teardown on shutdown signal; process exits regardless
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  if (READY_FILE && OWNER_TOKEN) {
    try {
      const readyPath = path.resolve(READY_FILE);
      const marker = JSON.parse(readFileSync(readyPath, "utf8"));
      if (marker.ownerToken === OWNER_TOKEN && marker.pid === process.pid) {
        rmSync(readyPath);
      }
    } catch (error) {
      // error-policy:J6 A stale/replaced readiness marker must not block shutdown.
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        console.warn(
          `${tag} could not remove owned readiness marker: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
