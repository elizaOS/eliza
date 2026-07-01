#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-nostr.
 * tsc-only (non-bundled) plugin: no Bun.build step — the shared driver runs
 * `tsc --project tsconfig.json --noCheck` via the empty-targets path.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-nostr",
  targets: [],
  dtsProject: "tsconfig.json",
});
