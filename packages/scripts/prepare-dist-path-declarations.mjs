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
  process.platform === "win32" ? "tsc6.cmd" : "tsc6",
);
const tsc = existsSync(localTsc) ? localTsc : "tsc6";

export const emits = [
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

export function prepareDistPathDeclarations(options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const compiler = options.tsc ?? tsc;
  const env = options.env ?? process.env;

  for (const emit of options.emits ?? emits) {
    console.log(`[prepare-dist-path-declarations] ${emit.label}`);
    const result = spawn(compiler, emit.args, {
      cwd: emit.cwd,
      env,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(
        `[prepare-dist-path-declarations] failed to start ${compiler}: ${result.error.message}`,
      );
      return 1;
    }
    if (result.status !== 0) {
      console.error(
        `[prepare-dist-path-declarations] ${emit.label} failed with exit code ${result.status}`,
      );
      return result.status ?? 1;
    }
  }

  console.log(
    `[prepare-dist-path-declarations] prepared ${(options.emits ?? emits).length} declaration emit(s)`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(prepareDistPathDeclarations());
}
