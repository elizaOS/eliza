#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-pii-guard (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * `@huggingface/transformers` (and its `onnxruntime-node` / `sharp` native deps)
 * stay external so the bundle never inlines the ONNX runtime.
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-pii-guard",
  clean: true,
  externals: "auto",
  targets: [
    {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
  rewriteDistImports: true,
});
