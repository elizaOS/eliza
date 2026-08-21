#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-dropbox. tsc-only (non-bundled) plugin: the
 * shared driver cleans dist then runs `tsc --project tsconfig.json --noCheck`
 * via the empty-targets path.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-dropbox",
  clean: true,
  targets: [],
  dtsProject: "tsconfig.json",
});
