#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-pdf (Node). Orchestration lives in
 * the shared driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * pdfjs-dist is a transitive dep (via unpdf); keep it externalized so the worker
 * entry inside pdfjs-dist isn't inlined. The emitted `dist/` is byte-identical
 * to the previous hand-rolled build.
 */
import { buildPlugin } from "../plugin-build";

// Single-quoted re-export to keep the emitted .d.ts byte-stable.
const reexport = "export * from '../index';\nexport { default } from '../index';\n";

await buildPlugin({
  name: "@elizaos/plugin-pdf",
  clean: true,
  externalsOptions: { extra: ["pdfjs-dist"] },
  targets: [
    {
      label: "Node",
      entry: "index.node.ts",
      outSubdir: "node",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsShims: [{ path: "node/index.d.ts", content: reexport }],
});
