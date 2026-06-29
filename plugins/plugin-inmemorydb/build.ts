#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-inmemorydb (Node + Browser). Orchestration
 * lives in the shared driver (plugins/plugin-build.ts); this lists only what
 * differs.
 *
 * Migrated from the legacy `runBuild`/`generateDts` (packages/core/build)
 * driver to the shared `buildPlugin` driver as part of issue #10078 (one build
 * helper). The emitted `dist/` is byte-identical to the previous output.
 *
 * runBuild → buildPlugin mapping:
 *  - Two `runBuild` calls → two `targets[]`: Node (entry "./index.ts",
 *    outSubdir "node", target "node") and Browser (entry "./index.browser.ts",
 *    outSubdir "browser", target "browser"), both esm.
 *  - sourcemap: true → "linked": runBuild forwards the boolean `true` to
 *    Bun.build, which emits an external `.js.map` + `//# sourceMappingURL=` /
 *    `//# debugId=` comments — exactly Bun's "linked" mode (verified, including
 *    debugId).
 *  - naming: createElizaBuildConfig sets a fixed naming template; it determines
 *    the sourcemap bytes (and thus the debugId), so it is reproduced verbatim
 *    here to keep the `.js` + `.js.map` byte-identical.
 *  - external: both runBuild calls pass ["@elizaos/core"]; the plugin's only
 *    non-builtin import is @elizaos/core (everything else is `node:*`), so the
 *    single explicit entry reproduces both bundles byte-for-byte. buildPlugin
 *    applies one externals list to every target; that is fine here because both
 *    targets share the same effective set.
 *  - generateDts("tsconfig.build.json", false) [false = throwOnError] →
 *    dtsProject "tsconfig.build.json" + dtsEmitDeclarationOnly (runBuild's
 *    generateDts runs `tsc --emitDeclarationOnly --noCheck …`) + dtsTolerant
 *    (the `false` throwOnError = warn-and-continue). runBuild additionally
 *    passed `--composite false --incremental false`, which suppressed the
 *    `dist/tsconfig.tsbuildinfo` emit; buildPlugin cannot pass extra tsc flags,
 *    so that suppression is now encoded directly in tsconfig.build.json
 *    (composite:false, tsBuildInfoFile removed). The per-file `.d.ts` tree is
 *    byte-identical either way; this only avoids the stray tsbuildinfo.
 *  - The two post-emit alias writes (root + node) → dtsShims, reproduced
 *    byte-for-byte (double-quoted specifiers, trailing newline).
 */
import { buildPlugin } from "../plugin-build";

const naming = {
  entry: "[dir]/[name].[ext]",
  chunk: "[name]-[hash].[ext]",
  asset: "[name]-[hash].[ext]",
} as const;

const rootAlias = [
  'export * from "./browser/index";',
  'export { default } from "./browser/index";',
  "",
].join("\n");

const nodeAlias = [
  'export * from "../browser/index";',
  'export { default } from "../browser/index";',
  "",
].join("\n");

await buildPlugin({
  name: "@elizaos/plugin-inmemorydb",
  clean: true,
  externals: ["@elizaos/core"],
  targets: [
    {
      label: "Node",
      entry: "./index.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming,
    },
    {
      label: "Browser",
      entry: "./index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      sourcemap: "linked",
      naming,
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  dtsTolerant: true,
  dtsShims: [
    { path: "index.d.ts", content: rootAlias },
    { path: "node/index.d.ts", content: nodeAlias },
  ],
});
