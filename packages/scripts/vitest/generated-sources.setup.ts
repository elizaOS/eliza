/**
 * Vitest global setup that materializes the generated i18n keyword module before
 * any source-aliased suite loads `@elizaos/core`.
 *
 * `packages/core/src/i18n/validation-keywords.ts` imports
 * `./generated/validation-keyword-data.ts`, which is git-ignored and produced by
 * `packages/shared/scripts/generate-keywords.mjs`. Core's own `prebuild` and
 * `typecheck` scripts run that generator, and `run-turbo.mjs` materializes it
 * before scheduling build/typecheck tasks. A package whose Vitest config aliases
 * `@elizaos/core` to source bypasses all three, so its declared `vitest run`
 * fails to resolve the generated module on a checkout that has not built core.
 *
 * Consumers wire this module through `globalSetup`, which runs once per Vitest
 * process before collection. Generation failure throws so the lane fails loudly
 * rather than reporting unresolved-import suites. The generator writes every
 * keyword output through process-unique temporary files and atomic renames, so
 * running it for every lane setup is concurrency-safe and prevents a surviving
 * generated module from becoming stale after an input or branch change.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./repo-root.ts";

/** Generator path, relative to a repository root, that owns keyword modules. */
export const KEYWORD_GENERATOR_RELATIVE_PATH =
  "packages/shared/scripts/generate-keywords.mjs";

/** Core-side generated module consumed through the `@elizaos/core` source alias. */
export const CORE_GENERATED_KEYWORD_DATA_RELATIVE_PATH =
  "packages/core/src/i18n/generated/validation-keyword-data.ts";

/** Absolute path of the generator in this checkout. */
export const keywordGeneratorPath = path.join(
  repoRoot,
  KEYWORD_GENERATOR_RELATIVE_PATH,
);

/** Absolute path of the generated core module in this checkout. */
export const coreGeneratedKeywordDataPath = path.join(
  repoRoot,
  CORE_GENERATED_KEYWORD_DATA_RELATIVE_PATH,
);

/**
 * Run the keyword generator and verify its core output. `root` exists so tests
 * can drive a throwaway checkout instead of this one.
 */
export function materializeGeneratedSources(root: string = repoRoot): boolean {
  const generator = path.join(root, KEYWORD_GENERATOR_RELATIVE_PATH);
  const generated = path.join(root, CORE_GENERATED_KEYWORD_DATA_RELATIVE_PATH);
  const result = spawnSync(process.execPath, [generator], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `[vitest] generate-keywords.mjs exited with status ${result.status}; ` +
        `${generated} is required by source-aliased @elizaos/core suites.`,
    );
  }
  if (!existsSync(generated)) {
    throw new Error(
      `[vitest] generate-keywords.mjs succeeded but did not write ${generated}.`,
    );
  }
  return true;
}

export default function setup(): void {
  materializeGeneratedSources();
}
