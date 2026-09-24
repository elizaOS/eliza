#!/usr/bin/env bun
/** Builds the PDF service's Node ESM entry and declarations, keeping PDF workers external. */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-pdf",
  clean: true,
  externalsOptions: { extra: ["pdfjs-dist"] },
  targets: [
    {
      label: "Node ESM",
      entry: "index.ts",
      outSubdir: ".",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  rewriteDistImports: true,
});
