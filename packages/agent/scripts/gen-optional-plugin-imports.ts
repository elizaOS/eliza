#!/usr/bin/env bun
/**
 * Regenerate `src/runtime/optional-plugin-imports.generated.ts` from the
 * `OPTIONAL_STATIC_PLUGIN_PACKAGES` source of truth so the bundler sees literal
 * `import()` specifiers without a hand-maintained if-chain.
 *
 * Run: bun run --cwd packages/agent gen:optional-plugin-imports
 * A drift check (optional-plugins.test.ts) fails CI if this output is stale.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPTIONAL_STATIC_PLUGIN_PACKAGES,
  renderOptionalPluginImportsModule,
} from "../src/runtime/optional-plugins.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(
  here,
  "..",
  "src",
  "runtime",
  "optional-plugin-imports.generated.ts",
);

writeFileSync(
  outPath,
  renderOptionalPluginImportsModule(OPTIONAL_STATIC_PLUGIN_PACKAGES),
);

// Format so the committed file matches the repo's biome style; the drift test
// asserts on the exported keys, not text, so formatting is free to differ.
spawnSync("bunx", ["@biomejs/biome", "format", "--write", outPath], {
  stdio: "inherit",
});

console.log(
  `[gen-optional-plugin-imports] wrote ${OPTIONAL_STATIC_PLUGIN_PACKAGES.length} importers -> ${path.relative(path.resolve(here, ".."), outPath)}`,
);
