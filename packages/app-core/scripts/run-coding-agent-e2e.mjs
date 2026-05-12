#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..", "..");
const requiredTests = [
  "eliza/plugins/app-task-coordinator/test/coding-agent-codex-artifact.live.e2e.test.ts",
  "eliza/plugins/app-task-coordinator/test/quicksort-coding-agent.live.e2e.test.ts",
];
const missingTests = requiredTests.filter(
  (relativePath) => !fs.existsSync(path.join(repoRoot, relativePath)),
);

if (missingTests.length > 0) {
  console.error(
    `[coding-agent-e2e] Required focused coding-agent live E2E files are missing:\n${missingTests.join("\n")}`,
  );
  process.exit(1);
}

const result = spawnSync(
  "node",
  [
    "eliza/packages/app-core/scripts/run-with-env.mjs",
    "ELIZA_LIVE_TEST=1",
    "--",
    "bunx",
    "vitest",
    "run",
    "--config",
    "eliza/test/vitest/live-e2e.config.ts",
    ...requiredTests,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  },
);

process.exit(result.status ?? 1);
