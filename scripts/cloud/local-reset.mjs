#!/usr/bin/env node
/**
 * Local Cloud reset utility.
 *
 * - Wipes the PGlite data directory (only when DATABASE_URL is a local pglite:// path)
 * - Wipes the local in-memory Redis snapshot file (if any)
 * - Re-applies cloud-shared Drizzle migrations
 *
 * Refuses to run if DATABASE_URL looks like a remote Postgres host.
 *
 * Pass --dry-run to print actions without performing them.
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");

function log(...args) {
  console.log("[cloud:local:reset]", ...args);
}

function fail(msg) {
  console.error("[cloud:local:reset] ERROR:", msg);
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL ?? "";

// Safety: refuse anything that isn't an obviously local pglite path or localhost.
const isPgliteLocal = /^pglite:\/\/\.\//.test(DATABASE_URL);
const isLocalhostPg =
  /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(
    DATABASE_URL,
  );

if (!DATABASE_URL) {
  fail("DATABASE_URL is not set. Refusing to run.");
}
if (!isPgliteLocal && !isLocalhostPg) {
  fail(
    `DATABASE_URL='${DATABASE_URL}' does not look local (pglite://./… or postgres://…@localhost). Refusing.`,
  );
}

const pgliteRel =
  isPgliteLocal && DATABASE_URL.replace(/^pglite:\/\//, "").trim();
const pgliteAbs = pgliteRel ? path.resolve(repoRoot, pgliteRel) : null;
const redisSnapshot = path.resolve(repoRoot, ".eliza", ".redis-mock-snapshot.json");

function maybeRemove(target, label) {
  if (!target) return;
  if (!existsSync(target)) {
    log(`${label}: nothing to remove at ${target}`);
    return;
  }
  const stat = statSync(target);
  const kind = stat.isDirectory() ? "directory" : "file";
  if (DRY) {
    log(`[dry-run] would remove ${kind} ${target} (${label})`);
    return;
  }
  log(`removing ${kind} ${target} (${label})`);
  rmSync(target, { recursive: true, force: true });
}

maybeRemove(pgliteAbs, "PGlite data dir");
maybeRemove(redisSnapshot, "in-memory redis snapshot");

const migrateCmd = "bun run --cwd packages/cloud-shared db:migrate";
if (DRY) {
  log(`[dry-run] would run: ${migrateCmd}`);
  log("[dry-run] complete");
  process.exit(0);
}

log(`running: ${migrateCmd}`);
try {
  execSync(migrateCmd, { cwd: repoRoot, stdio: "inherit" });
} catch (err) {
  fail(`migration step failed: ${err?.message ?? err}`);
}
log("done");
