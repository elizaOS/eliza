#!/usr/bin/env bun
import { $ } from "bun";
import { rmSync, existsSync } from "fs";

async function build() {
  const totalStart = Date.now();
  const pkg = await Bun.file("package.json").json();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];

  // Use the clean script from package.json
    // Clean dist directory
    console.log("🧹 Cleaning...");
    if (existsSync("dist")) {
        rmSync("dist", { recursive: true, force: true });
    }
    if (existsSync(".turbo")) {
        rmSync(".turbo", { recursive: true, force: true });
    }

  const esmStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-rolodex...");
  const esmResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!esmResult.success) {
    console.error(esmResult.logs);
    throw new Error("ESM build failed");
  }
  console.log(`✅ Build complete in ${((Date.now() - esmStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  try {
    await $`tsc --project tsconfig.build.json`;
    console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);
  } catch (error) {
    console.warn(`⚠️  TypeScript declaration generation had errors (${((Date.now() - dtsStart) / 1000).toFixed(2)}s)`);
    console.warn("   Build will continue - fix type errors when possible");
  }

  console.log(`🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
