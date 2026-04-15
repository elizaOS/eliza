#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");
const candidateTests = [
  "eliza/apps/app-task-coordinator/test/coding-agent-codex-artifact.live.e2e.test.ts",
  "eliza/apps/app-task-coordinator/test/quicksort-coding-agent.live.e2e.test.ts",
].filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)));

if (candidateTests.length === 0) {
  console.log(
    "[coding-agent-e2e] No app-task-coordinator live E2E tests are present in this checkout; skipping focused coding-agent vitest files.",
  );
  process.exit(0);
}

const result = spawnSync(
  "node",
  [
    "eliza/packages/app-core/scripts/run-with-env.mjs",
    "MILADY_LIVE_TEST=1",
    "ELIZA_LIVE_TEST=1",
    "--",
    "bunx",
    "vitest",
    "run",
    "--config",
    "test/vitest/live-e2e.config.ts",
    ...candidateTests,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  },
);

process.exit(result.status ?? 1);
