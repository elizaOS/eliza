#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-computeruse. Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * Three Node/ESM entrypoints are bundled with linked sourcemaps and flat
 * `[name].[ext]` naming (index + register-routes at the dist root, the mobile
 * OCR provider under dist/mobile). Declarations are emitted declaration-only
 * from tsconfig.build.json, preserving the package's established `dist/`
 * layout for downstream imports.
 */
import { buildPlugin } from "../plugin-build";

const naming = { entry: "[name].[ext]" };

await buildPlugin({
  name: "plugin-computeruse",
  clean: true,
  externalsOptions: { extra: ["node:*"] },
  targets: [
    {
      label: "index",
      entry: "./src/index.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming,
    },
    {
      label: "register-routes",
      entry: "./src/register-routes.ts",
      outSubdir: "",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming,
    },
    {
      label: "mobile/ocr-provider",
      entry: "./src/mobile/ocr-provider.ts",
      outSubdir: "mobile",
      target: "node",
      format: "esm",
      sourcemap: "linked",
      naming,
    },
  ],
  dtsProject: "tsconfig.build.json",
  dtsEmitDeclarationOnly: true,
});
