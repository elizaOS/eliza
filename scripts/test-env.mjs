#!/usr/bin/env node
/**
 * Print shell `export` statements that wire the test suite to Cerebras
 * `gpt-oss-120b` (the default LLM for both PR and post-merge lanes).
 *
 * Usage:
 *   node scripts/test-env.mjs              # PR lane (default)
 *   node scripts/test-env.mjs --lane=post-merge
 *
 * Then `eval "$(node scripts/test-env.mjs)"` in your shell, or pipe to
 * `bun run test`-driving scripts that source the result.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Best-effort .env load — match the convention used by live-provider.ts.
// dotenv is an optional dep; missing module is fine, missing file is fine.
async function loadDotenv() {
  for (const candidate of [".env.test", ".env"]) {
    const file = resolve(REPO_ROOT, candidate);
    if (!existsSync(file)) continue;
    try {
      const dotenv = await import("dotenv");
      // dotenv@17 prints a tip banner to stdout by default; suppress it so the
      // script's stdout stays a clean stream of `export …` lines for `eval`.
      dotenv.config({ path: file, override: false, quiet: true });
    } catch {
      const text = readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
        if (!match) continue;
        const [, key, raw] = match;
        if (process.env[key]) continue;
        const value = raw.replace(/^['"]|['"]$/g, "");
        process.env[key] = value;
      }
    }
  }
}

function parseArgs(argv) {
  const args = { lane: "pr" };
  for (const arg of argv) {
    const laneMatch = /^--lane=(.+)$/.exec(arg);
    if (laneMatch) {
      args.lane = laneMatch[1];
    }
  }
  if (args.lane !== "pr" && args.lane !== "post-merge") {
    process.stderr.write(
      `error: --lane must be 'pr' or 'post-merge' (got '${args.lane}')\n`,
    );
    process.exit(2);
  }
  return args;
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

await loadDotenv();
const { lane } = parseArgs(process.argv.slice(2));

const cerebrasKey = process.env.CEREBRAS_API_KEY?.trim();
if (!cerebrasKey) {
  process.stderr.write(
    "error: CEREBRAS_API_KEY is not set.\n" +
      "Create one at https://inference.cerebras.ai and put it in .env or .env.test.\n",
  );
  process.exit(1);
}

const exports = [
  ["CEREBRAS_API_KEY", cerebrasKey],
  ["OPENAI_API_KEY", cerebrasKey],
  ["OPENAI_BASE_URL", "https://api.cerebras.ai/v1"],
  ["OPENAI_LARGE_MODEL", "gpt-oss-120b"],
  ["OPENAI_SMALL_MODEL", "gpt-oss-120b"],
  ["ELIZA_LIVE_TEST", "1"],
  ["TEST_LANE", lane],
];

if (lane === "post-merge") {
  exports.push(["ELIZA_REAL_APIS", "1"]);
}

for (const [key, value] of exports) {
  process.stdout.write(`export ${key}=${shellEscape(value)}\n`);
}
