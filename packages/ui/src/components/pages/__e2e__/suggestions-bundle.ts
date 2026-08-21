/**
 * esbuild options the proactive-suggestions browser fixture is bundled with,
 * shared by `run-suggestions-e2e.mjs` (phase 2) and its regression test so the
 * two can never drift.
 *
 * The fixture graph reaches server-only edges that are dead at render in a
 * headless page: `state/parsers` re-exports streaming-text helpers whose
 * canonical home is the `@elizaos/shared` barrel, and the `api/client` barrel
 * value-imports `@elizaos/core` from `client-cloud`. Vite resolves core's
 * published `browser` condition in production, but `eliza-source` outranks
 * `browser` for esbuild, so those edges must be aliased or stubbed or the
 * browser build fails on `node:*` builtins.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions, Plugin } from "esbuild";
import {
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/esbuild-stubs.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the fixture entry point. */
export const suggestionsFixtureEntry = join(here, "suggestions-fixture.tsx");

/**
 * Resolve the `@elizaos/shared` barrel to the exact pure, browser-safe module
 * the fixture graph actually consumes, instead of dragging http-helpers in.
 */
function aliasSharedBarrel(): Plugin {
  const sharedStreamingText = join(
    here,
    "..",
    "..",
    "..",
    "..",
    "..",
    "shared",
    "src",
    "utils",
    "streaming-text.ts",
  );
  return {
    name: "alias-shared-barrel",
    setup(build) {
      build.onResolve({ filter: /^@elizaos\/shared$/ }, () => ({
        path: sharedStreamingText,
      }));
    },
  };
}

/** Build options for the phase-2 browser bundle. */
export function suggestionsFixtureBuildOptions(): BuildOptions {
  return {
    entryPoints: [suggestionsFixtureEntry],
    bundle: true,
    format: "iife",
    platform: "browser",
    conditions: ["eliza-source", "browser"],
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [aliasSharedBarrel(), stubElizaCore(), stubNodeBuiltins()],
    write: false,
  };
}
