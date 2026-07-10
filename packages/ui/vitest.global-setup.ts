/**
 * Ensures the generated i18n keyword data exists before the jsdom suite runs.
 *
 * `@elizaos/core` re-exports `src/i18n/generated/validation-keyword-data.ts`,
 * which is a gitignored codegen artifact produced by core's `prebuild`. The UI
 * suite reaches core transitively through the `@elizaos/shared` barrel, so in a
 * lane that runs *before* the workspace build (e.g. the changed-files coverage
 * gate) that file is absent and every ui test module fails to resolve it at
 * load time. Regenerate it here — guarded on existence so a normal
 * post-build run is a no-op, mirroring core's own `[ -f … ] || generate` guard.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const monorepoRoot = resolve(packageRoot, "../..");
const generatedKeywordData = resolve(
  monorepoRoot,
  "packages/core/src/i18n/generated/validation-keyword-data.ts",
);
const generator = resolve(
  monorepoRoot,
  "packages/shared/scripts/generate-keywords.mjs",
);

export function setup() {
  if (existsSync(generatedKeywordData)) return;
  const result = spawnSync(process.execPath, [generator], {
    cwd: monorepoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `generate-keywords failed (exit ${result.status ?? "signal"}); ${dirname(
        generatedKeywordData,
      )} could not be produced`,
    );
  }
}
