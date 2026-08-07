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
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const ELIZA_ROOT = existsSync(join(REPO_ROOT, "eliza", "packages", "shared"))
  ? join(REPO_ROOT, "eliza")
  : REPO_ROOT;

const SHARED_PKG_DIR = join(ELIZA_ROOT, "packages", "shared");
const GENERATOR_PATH = join(SHARED_PKG_DIR, "scripts", "generate-keywords.mjs");
const KEYWORDS_DIR = join(SHARED_PKG_DIR, "src", "i18n", "keywords");
const GENERATED_PATHS = [
  join(
    SHARED_PKG_DIR,
    "src",
    "i18n",
    "generated",
    "validation-keyword-data.ts",
  ),
  join(
    SHARED_PKG_DIR,
    "src",
    "i18n",
    "generated",
    "validation-keyword-data.js",
  ),
  join(
    ELIZA_ROOT,
    "packages",
    "core",
    "src",
    "i18n",
    "generated",
    "validation-keyword-data.ts",
  ),
];

export function keywordGenerationNeeded({
  generatorPath = GENERATOR_PATH,
  keywordsDir = KEYWORDS_DIR,
  generatedPaths = GENERATED_PATHS,
} = {}) {
  if (!existsSync(generatorPath) || !existsSync(keywordsDir)) return true;
  if (generatedPaths.some((outputPath) => !existsSync(outputPath))) return true;

  const keywordPaths = readdirSync(keywordsDir)
    .filter((name) => name.endsWith(".keywords.json"))
    .map((name) => join(keywordsDir, name));
  if (keywordPaths.length === 0) return true;

  const newestInputMtime = Math.max(
    statSync(generatorPath).mtimeMs,
    ...keywordPaths.map((inputPath) => statSync(inputPath).mtimeMs),
  );
  const oldestOutputMtime = Math.min(
    ...generatedPaths.map((outputPath) => statSync(outputPath).mtimeMs),
  );
  return oldestOutputMtime < newestInputMtime;
}

export function runKeywordGenerator({
  generatorPath = GENERATOR_PATH,
  cwd = SHARED_PKG_DIR,
  keywordsDir = KEYWORDS_DIR,
  generatedPaths = GENERATED_PATHS,
} = {}) {
  if (!existsSync(generatorPath)) {
    console.warn(
      `[ensure-shared-i18n-data] generator not found at ${generatorPath}; skipping`,
    );
    return { skipped: true };
  }

  if (
    !keywordGenerationNeeded({ generatorPath, keywordsDir, generatedPaths })
  ) {
    return { skipped: true };
  }

  const result = spawnSync(process.execPath, [generatorPath], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

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

export function isDirectRun(moduleUrl, entryPath = process.argv[1]) {
  return (
    typeof entryPath === "string" &&
    moduleUrl === pathToFileURL(resolve(entryPath)).href
  );
}

if (isDirectRun(import.meta.url)) {
  runKeywordGenerator();
}
