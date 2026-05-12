#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function build() {
  const totalStart = Date.now();
  const pkg = await Bun.file("package.json").json();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];

  console.log("Cleaning...");
  if (existsSync("dist")) rmSync("dist", { recursive: true, force: true });

  const buildStart = Date.now();
  console.log("Building @elizaos/plugin-mysticism...");
  const result = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!result.success) {
    console.error(result.logs);
    throw new Error("Build failed");
  }
  console.log(`Build complete in ${((Date.now() - buildStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("Generating TypeScript declarations...");
  const { $ } = await import("bun");
  try {
    if (existsSync("tsconfig.build.json")) await $`tsc --project tsconfig.build.json`.quiet();
    console.log(`Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);
  } catch (_error) {
    console.warn(
      `Declaration generation had errors (${((Date.now() - dtsStart) / 1000).toFixed(2)}s)`
    );
  }

  const distDir = join(process.cwd(), "dist");
  if (!existsSync(distDir)) await mkdir(distDir, { recursive: true });
  const rootIndexDtsPath = join(distDir, "index.d.ts");
  if (!existsSync(rootIndexDtsPath)) {
    await writeFile(
      rootIndexDtsPath,
      'export * from "./index";\nexport { default } from "./index";\n',
      "utf8"
    );
  }

  console.log(`All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
