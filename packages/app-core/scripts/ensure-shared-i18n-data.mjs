#!/usr/bin/env node
/**
 * Ensure generated i18n keyword data exists for @elizaos/shared and
 * @elizaos/core. Source of truth is packages/shared/src/i18n/keywords/*.keywords.json
 * and the generator is packages/shared/scripts/generate-keywords.mjs.
 *
 * The generated files are gitignored, so Vite/Rolldown builds (docker-ci-smoke,
 * apps/app UI build) will fail to resolve `./generated/validation-keyword-data.js`
 * on a fresh checkout unless this step runs during repo setup.
 *
 * Idempotent: re-running regenerates the same output.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const ELIZA_ROOT = existsSync(join(REPO_ROOT, "eliza", "packages", "shared"))
  ? join(REPO_ROOT, "eliza")
  : REPO_ROOT;

const SHARED_PKG_DIR = join(ELIZA_ROOT, "packages", "shared");
const GENERATOR_PATH = join(SHARED_PKG_DIR, "scripts", "generate-keywords.mjs");

export function runKeywordGenerator({
  generatorPath = GENERATOR_PATH,
  cwd = SHARED_PKG_DIR,
  target = "ts",
} = {}) {
  if (!existsSync(generatorPath)) {
    console.warn(
      `[ensure-shared-i18n-data] generator not found at ${generatorPath}; skipping`,
    );
    return { skipped: true };
  }

  const result = spawnSync(
    process.execPath,
    [generatorPath, "--target", target],
    {
      cwd,
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `generate-keywords.mjs exited with code ${result.status ?? 1}`,
    );
  }

  return { skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKeywordGenerator();
}
