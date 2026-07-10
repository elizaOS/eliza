#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-elizacloud. Orchestration lives in the
 * shared driver; this lists only what differs:
 *   - Node ESM bundle  -> dist/node
 *   - Browser bundle (minified) -> dist/browser
 *   - Node CJS bundle  -> dist/cjs (index.node.js renamed to index.node.cjs)
 *   - per-file subpath glob over src/** (minus the dedicated entrypoints and
 *     tests) that emits under dist/src via `naming`, then is flattened up into
 *     dist/ (and dist/src removed) by the shared driver's `flatten` hook.
 * Declarations come from tsconfig.build.json (emitDeclarationOnly), followed by
 * three hand-written alias shims. The emitted dist/ is byte-identical to the
 * previous hand-rolled build.
 */
import { buildPlugin } from "../plugin-build";

// Per-file subpath bundles: every src module except the dedicated Node/Browser
// entrypoints and tests. Emitted under dist/src (naming "[dir]/[name]"), then
// flattened up into dist/ by the driver's `flatten` step.
// Bun.Glob.scanSync yields native separators, so paths must be normalized to
// forward slashes before the string filters below — otherwise on Windows every
// exclusion silently fails and dist gains vite-only components plus duplicate
// root entrypoints (#15779).
const subpathEntries = Array.from(new Bun.Glob("src/**/*.{ts,tsx}").scanSync("."))
  .map((entry) => entry.replaceAll("\\", "/"))
  .filter((entry) => {
    if (entry.includes("__tests__/") || entry.endsWith(".test.ts") || entry.endsWith(".test.tsx"))
      return false;
    if (entry === "src/index.node.ts" || entry === "src/index.browser.ts") return false;
    // View components are vite-only (React/JSX against host-external
    // @elizaos/ui); the per-file bun bundle has no react external and would
    // choke on them. They ship exclusively via `build:views` → dist/views.
    if (entry.startsWith("src/components/")) return false;
    return true;
  })
  .sort();

// Single-quoted re-exports to keep the emitted alias .d.ts byte-stable. The
// specifiers carry an explicit .js extension because TypeScript's node16/nodenext
// resolution rejects extensionless relative paths — consumers of the built
// package would get TS2307 on the exports "." types entry otherwise (#15779).
// TS maps the .js specifier to the tsc-emitted ../index.node.d.ts / ../index.d.ts.
const nodeReexport =
  "export * from '../index.node.js';\nexport { default } from '../index.node.js';\n";
const browserReexport = "export * from '../index.js';\nexport { default } from '../index.js';\n";

await buildPlugin({
  name: "@elizaos/plugin-elizacloud",
  clean: true,
  externals: "auto",
  targets: [
    {
      label: "Node",
      entry: "src/index.node.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
    },
    {
      label: "Browser",
      entry: "src/index.browser.ts",
      outSubdir: "browser",
      target: "browser",
      format: "esm",
      minify: true,
    },
    {
      label: "Node (CJS)",
      entry: "src/index.node.ts",
      outSubdir: "cjs",
      target: "node",
      format: "cjs",
      renames: [["index.node.js", "index.node.cjs"]],
    },
    {
      label: "Exported subpaths",
      entry: subpathEntries,
      outSubdir: "",
      target: "node",
      format: "esm",
      naming: {
        entry: "[dir]/[name].[ext]",
        chunk: "chunks/[name]-[hash].[ext]",
        asset: "assets/[name]-[hash].[ext]",
      },
    },
  ],
  flatten: [{ from: "src" }],
  dtsProject: "tsconfig.build.json",
  dtsShims: [
    { path: "node/index.d.ts", content: nodeReexport },
    { path: "browser/index.d.ts", content: browserReexport },
    { path: "cjs/index.d.ts", content: nodeReexport },
  ],
});
