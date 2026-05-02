#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

async function build(): Promise<void> {
  const totalStart = Date.now();

  console.log("🔨 Building @elizaos/plugin-solana...\n");

  if (existsSync("dist")) {
    await rm("dist", { recursive: true, force: true });
  }

  const pkg = await Bun.file("./package.json").json();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];

  console.log("📦 Bundling with Bun...");
  const esmResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!esmResult.success) {
    console.error("Build failed:");
    for (const log of esmResult.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${esmResult.outputs.length} file(s)`);

  console.log("📝 Generating TypeScript declarations...");
  const tscProcess = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await tscProcess.exited;

  // noEmitOnError: false in tsconfig.build.json allows declarations to be generated
  // even if there are type errors (which can happen with complex monorepo resolution)
  if (tscProcess.exitCode !== 0) {
    console.warn("⚠️ TypeScript declaration generation had warnings (non-blocking)");
  }

  console.log(`\n✅ Build complete in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
