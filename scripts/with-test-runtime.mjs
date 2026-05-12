#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTestRuntimeEnv } from "./lib/test-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/with-test-runtime.mjs <command> [...args]");
  process.exit(1);
}

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: buildTestRuntimeEnv(process.env, { repoRoot }),
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
