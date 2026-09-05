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
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildPlugin } from "../plugin-build";

const naming = { entry: "[name].[ext]" };

/**
 * Declaration emit consumes workspace dependency types from their built
 * `dist/` boundaries (tsconfig.build.json extends the shared build config),
 * so the dependency dists must exist before this build runs. Turbo orders
 * this via the default `build` task's `^build` + `@elizaos/core#build` deps,
 * but a direct `bun run --cwd plugins/plugin-computeruse build` on a fresh
 * checkout would otherwise fail silently: `--noCheck` swallows the TS2307
 * unresolved-module diagnostics and the build would exit 0 with declarations
 * whose dependency imports were dropped (#29772).
 *
 * Rather than breaking that documented standalone command (#29901 review),
 * build the missing dependency dists from source right here, and only fail
 * loud if a dependency build actually fails or its entry declaration is still
 * absent afterwards.
 */
const repoRoot = path.resolve(import.meta.dir, "../..");
const requiredDistEntryPoints = [
  { declaration: "../../packages/core/dist/index.d.ts", pkg: "packages/core" },
  { declaration: "../../packages/ui/dist/index.d.ts", pkg: "packages/ui" },
  {
    declaration: "../../packages/shared/dist/index.d.ts",
    pkg: "packages/shared",
  },
] as const;

const missing = requiredDistEntryPoints.filter(
  (dep) => !existsSync(path.resolve(import.meta.dir, dep.declaration)),
);
if (missing.length > 0) {
  const missingPkgs = [...new Set(missing.map((dep) => dep.pkg))];
  console.warn(
    `[plugin-computeruse] dependency dist declarations absent for ${missingPkgs.join(", ")}; ` +
      "building them from source so the standalone package build stays supported (#29901).",
  );
  for (const pkg of missingPkgs) {
    const build = Bun.spawn(["bun", "run", "--cwd", pkg, "build"], {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await build.exited;
    if (status !== 0) {
      throw new Error(
        `plugin-computeruse declaration build could not prepare dependency ${pkg}: ` +
          `\`bun run --cwd ${pkg} build\` exited ${status}.`,
      );
    }
  }
  const stillMissing = missing.filter(
    (dep) => !existsSync(path.resolve(import.meta.dir, dep.declaration)),
  );
  if (stillMissing.length > 0) {
    throw new Error(
      `plugin-computeruse declaration build requires built dependency dists: ${stillMissing
        .map((dep) => dep.declaration)
        .join(
          ", ",
        )}. Their package builds exited 0 but the entry declarations ` +
        "are still absent — the dist layout may have changed.",
    );
  }
}

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
