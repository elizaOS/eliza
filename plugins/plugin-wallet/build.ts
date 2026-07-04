#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-wallet (Node, multi-entrypoint).
 * Orchestration lives in the shared driver (plugins/plugin-build.ts); this
 * lists only what differs. The emitted `dist/` is byte-identical to the
 * previous hand-rolled build.
 *
 * Notable specifics reproduced here:
 * - Five entrypoints are bundled together under `dist/` with Bun's default
 *   `[dir]/[name].[ext]` naming, so `src/sdk/index.ts` etc. keep their tree.
 * - Only the primary `index.js`/`index.js.map` are renamed to `.mjs`/`.mjs.map`
 *   (the package `main`/`exports` point at `dist/index.mjs`); the secondary
 *   entrypoints keep their `.js` names.
 * - Declarations are emitted via `tsconfig.build.json` (the package
 *   `tsconfig.json` is `noEmit: true` and carries no `outDir`/`rootDir`), which
 *   turns emit back on and pins `outDir`/`rootDir` to mirror the previous
 *   `tsc --noEmit false --outDir dist --rootDir src --declaration` CLI override.
 * - `dist/index.d.mts` is a byte-copy of the generated `dist/index.d.ts`
 *   (publishes a NodeNext `.d.mts` sibling for the `.mjs` entry), expressed via
 *   the driver's `dtsCopies` hook rather than a frozen `dtsShim`.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-wallet",
  clean: true,
  externals: "auto",
  targets: [
    {
      label: "Node",
      entry: [
        "src/index.ts",
        "src/diagnostic.ts",
        "src/sdk/index.ts",
        "src/wallet-action.ts",
        "src/lib/server-wallet-trade.ts",
      ],
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "external",
      naming: { entry: "[dir]/[name].[ext]" },
      renames: [
        ["index.js", "index.mjs"],
        ["index.js.map", "index.mjs.map"],
      ],
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  dtsCopies: [{ from: "index.d.ts", to: "index.d.mts" }],
});
