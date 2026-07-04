#!/usr/bin/env node
// Drives repo automation prepare dist path declarations with explicit CLI and CI behavior.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const localTsc = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const tsc = existsSync(localTsc) ? localTsc : "tsc";

const emits = [
  {
    label: "@elizaos/prompts",
    cwd: path.join(repoRoot, "packages/prompts"),
    args: [
      "--ignoreConfig",
      "--declaration",
      "--emitDeclarationOnly",
      "--noCheck",
      "--outDir",
      "dist",
      "--rootDir",
      "src",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ESNext",
      "src/index.ts",
    ],
  },
];

for (const emit of emits) {
  console.log(`[prepare-dist-path-declarations] ${emit.label}`);
  const result = spawnSync(tsc, emit.args, {
    cwd: emit.cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      `[prepare-dist-path-declarations] failed to start ${tsc}: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[prepare-dist-path-declarations] ${emit.label} failed with exit code ${result.status}`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log(
  `[prepare-dist-path-declarations] prepared ${emits.length} declaration emit(s)`,
);
