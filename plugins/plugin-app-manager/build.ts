#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-app-manager (Node). Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * Declarations are emitted via tsconfig.build.json, which supplies the
 * noEmit:false / rootDir:src / declarationDir overrides needed for declaration
 * output (the base tsconfig sets noEmit:true because allowImportingTsExtensions
 * forces it).
 */
import { buildPlugin } from "../plugin-build";

await buildPlugin({
  name: "@elizaos/plugin-app-manager",
  clean: true,
  externals: [
    "@elizaos/core",
    "@elizaos/agent",
    "@elizaos/plugin-registry",
    "@elizaos/shared",
    "dotenv",
    "node:*",
    "bun:*",
  ],
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
