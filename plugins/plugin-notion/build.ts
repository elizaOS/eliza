#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-notion. tsc-only (non-bundled) plugin: the
 * shared driver cleans dist then runs `tsc --project tsconfig.json --noCheck`
 * via the empty-targets path.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-notion",
  clean: true,
  targets: [],
  dtsProject: "tsconfig.json",
});
