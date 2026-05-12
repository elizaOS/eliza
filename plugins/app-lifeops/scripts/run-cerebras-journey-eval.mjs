#!/usr/bin/env node
// Cerebras-graded journey eval runner.
//
// Loads `eliza/.env` (and `plugins/app-lifeops/.env` if present), then invokes
// vitest on the live e2e suite. The suite skips itself if CEREBRAS_API_KEY is
// absent.
//
// Usage:
//   bun run plugins/app-lifeops/scripts/run-cerebras-journey-eval.mjs
//
// The vitest run produces:
//   plugins/app-lifeops/docs/audit/cerebras-journey-eval-results.json

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const elizaRoot = path.resolve(packageRoot, "..", "..");
const repoRoot = path.resolve(elizaRoot, "..");

const envCandidates = [
  path.join(packageRoot, ".env"),
  path.join(elizaRoot, ".env"),
  path.join(repoRoot, ".env"),
];
for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
  }
}

if (!process.env.CEREBRAS_API_KEY) {
  console.error(
    "[run-cerebras-journey-eval] CEREBRAS_API_KEY is not set after dotenv load. " +
      "Set it in eliza/.env or plugins/app-lifeops/.env before running.",
  );
  process.exit(1);
}

const testFile =
  "eliza/plugins/app-lifeops/test/journey-cerebras-eval.live.e2e.test.ts";
const vitestConfig = "eliza/test/vitest/live-e2e.config.ts";

console.info(
  `[run-cerebras-journey-eval] launching vitest --config ${vitestConfig} -- ${testFile}`,
);

const child = spawn(
  "bunx",
  ["vitest", "run", "--config", vitestConfig, testFile],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
