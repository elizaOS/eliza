#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-video (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs. The
 * emitted `dist/` is byte-identical to the previous hand-rolled build.
 *
 * Declarations are emitted straight from the package `tsconfig.json`, which
 * already sets `declaration`/`emitDeclarationOnly`/`outDir: dist`/`rootDir: src`
 * — the previous CLI's `--declaration`/`--declarationDir dist` overrides were
 * redundant with those settings.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-video",
  clean: true,
  externals: "auto",
  externalsOptions: { extra: ["node:*", "bun:*"] },
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "external",
    },
  ],
  dtsProject: "tsconfig.json",
  dtsEmitDeclarationOnly: true,
});
