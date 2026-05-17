#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-local-storage (Node ESM only)
 */

const externalDeps = ["@elizaos/core", "@brighter/storage-adapter-local"];

async function build(): Promise<void> {
  const totalStart = Date.now();

  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-local-storage for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
    naming: {
      entry: "index.js",
    },
  });
  if (!nodeResult.success) {
    console.error(nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(`✅ Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { $ } = await import("bun");
  try {
    await $`tsc --project tsconfig.build.json`;
  } catch (_e) {
    console.warn("⚠️ tsc failed, creating stub declarations instead");
  }
  await mkdir("dist", { recursive: true });
  const stubContent = `export * from "./src/index.js";\nexport { default } from "./src/index.js";\n`;
  await writeFile("dist/index.d.ts", stubContent);
  console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);

  console.log(`🎉 All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
