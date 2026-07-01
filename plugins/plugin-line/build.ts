#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-line.
 * tsc-only (non-bundled) plugin: no Bun.build step — the shared driver cleans
 * dist then runs `tsc --project tsconfig.json --noCheck` via the empty-targets
 * path.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-line",
  clean: true,
  targets: [],
  dtsProject: "tsconfig.json",
});
