#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-computeruse. Orchestration lives in the
 * shared driver (plugins/plugin-build.ts); this lists only what differs.
 *
 * Four ESM entrypoints are bundled with linked sourcemaps and flat
 * `[name].[ext]` naming (index, register, and register-routes at the dist root,
 * plus the mobile OCR provider under dist/mobile). Declarations are emitted
 * declaration-only from tsconfig.build.json, preserving the package's
 * established `dist/` layout for downstream imports.
 */
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
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
      label: "register",
      entry: "./src/register.ts",
      outSubdir: "",
      target: "browser",
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

if (process.platform === "darwin") {
  const outputDirectory = path.resolve("dist/native");
  const output = path.join(outputDirectory, "macos-ax-helper");
  await mkdir(outputDirectory, { recursive: true });
  const build = Bun.spawn(
    [
      "xcrun",
      "swiftc",
      "-O",
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
      "native/macos-ax-helper.swift",
      "-o",
      output,
    ],
    { cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" },
  );
  const status = await build.exited;
  if (status !== 0) {
    throw new Error(`macOS AX helper build failed with exit ${status}`);
  }
  await chmod(output, 0o755);
}
