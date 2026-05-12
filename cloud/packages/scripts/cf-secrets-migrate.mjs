#!/usr/bin/env node
/**
 * cf-secrets-migrate.mjs
 *
 * Reads a dotenv file and pushes every server-side secret into Cloudflare
 * Workers via `wrangler secret put`.
 *
 * Skips:
 *   - keys prefixed with NEXT_PUBLIC_ or VITE_   (build-time, not runtime)
 *   - empty values
 *   - comment / blank lines (handled by dotenv)
 *
 * Usage:
 *   node packages/scripts/cf-secrets-migrate.mjs                       # uses .env.production
 *   node packages/scripts/cf-secrets-migrate.mjs ./.env.staging        # explicit file
 *   node packages/scripts/cf-secrets-migrate.mjs --env staging         # passes --env to wrangler
 *   node packages/scripts/cf-secrets-migrate.mjs --env production --dry-run
 *   node packages/scripts/cf-secrets-migrate.mjs --only KEY1,KEY2      # only push these keys
 *
 * Re-runnable: wrangler will overwrite existing secrets in place.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";

const PUBLIC_PREFIXES = ["NEXT_PUBLIC_", "VITE_"];
const WORKER_DIR = "apps/api"; // wrangler must run inside the worker pkg

const { values, positionals } = parseArgs({
  options: {
    env: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    only: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .slice(2, 22)
      .join("\n"),
  );
  process.exit(0);
}

const envFilePath = resolve(positionals[0] ?? ".env.production");
if (!existsSync(envFilePath)) {
  console.error(`error: env file not found: ${envFilePath}`);
  process.exit(1);
}

const parsed = dotenv.parse(readFileSync(envFilePath, "utf8"));
const onlyKeys = values.only ? new Set(values.only.split(",").map((k) => k.trim())) : null;
const wranglerEnvFlag = values.env ? ["--env", values.env] : [];

const candidates = Object.entries(parsed).filter(([key, val]) => {
  if (!val || val.trim() === "") return false;
  if (PUBLIC_PREFIXES.some((p) => key.startsWith(p))) return false;
  if (onlyKeys && !onlyKeys.has(key)) return false;
  return true;
});

console.log(`source:   ${envFilePath}`);
console.log(`env:      ${values.env ?? "(default)"}`);
console.log(`worker:   cloud/${WORKER_DIR}`);
console.log(`secrets:  ${candidates.length}`);
console.log(`dry-run:  ${values["dry-run"] ? "yes" : "no"}`);
console.log("");

if (candidates.length === 0) {
  console.log("nothing to do.");
  process.exit(0);
}

if (values["dry-run"]) {
  for (const [key] of candidates) console.log(`  would set: ${key}`);
  process.exit(0);
}

let failures = 0;

for (const [key, value] of candidates) {
  process.stdout.write(`  setting ${key} ... `);
  const ok = await runWrangler(["secret", "put", key, ...wranglerEnvFlag], value);
  console.log(ok ? "ok" : "FAILED");
  if (!ok) failures++;
}

console.log("");
if (failures > 0) {
  console.error(`done with ${failures} failure(s).`);
  process.exit(1);
}
console.log("done.");

function runWrangler(args, stdinValue) {
  return new Promise((resolveP) => {
    const child = spawn("wrangler", args, {
      cwd: resolve(WORKER_DIR),
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", (err) => {
      console.error(`spawn error: ${err.message}`);
      resolveP(false);
    });
    child.on("exit", (code) => resolveP(code === 0));
    child.stdin.write(stdinValue);
    child.stdin.end();
  });
}
