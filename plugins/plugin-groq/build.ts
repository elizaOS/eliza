#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = ["@elizaos/core", "@ai-sdk/groq", "ai"] as const;

async function build(): Promise<void> {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  if (existsSync(distDir)) {
    await Bun.$`rm -rf ${distDir}`;
  }
  await mkdir(distDir, { recursive: true });

  // Node build
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-groq for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "node"),
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
  });
  if (!nodeResult.success) {
    console.error("Node build failed:", nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(`✅ Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  // Browser build
  const browserStart = Date.now();
  console.log("🌐 Building @elizaos/plugin-groq for Browser...");
  const browserResult = await Bun.build({
    entrypoints: ["index.browser.ts"],
    outdir: join(distDir, "browser"),
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
  });
  if (!browserResult.success) {
    console.error("Browser build failed:", browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(`✅ Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`);

  // Node CJS build
  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-groq for Node (CJS)...");
  const cjsResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "cjs"),
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps],
  });
  if (!cjsResult.success) {
    console.error("CJS build failed:", cjsResult.logs);
    throw new Error("CJS build failed");
  }
  try {
    await rename(join(distDir, "cjs", "index.node.js"), join(distDir, "cjs", "index.node.cjs"));
  } catch (e) {
    console.warn("CJS rename step warning:", e);
  }
  console.log(`✅ CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`);

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  const { $ } = await import("bun");
  await $`tsc --project tsconfig.build.json`;

  // Top-level `dist/index.d.ts` aggregates the node entrypoint declarations.
  // We re-export from the tsc-emitted `./node/index.node` rather than `./node/index`
  // to avoid forming a cycle with `dist/node/index.d.ts`, which tsc emits from
  // `index.ts` and which `index.node.ts` itself imports via `./index`.
  await writeFile(
    join(distDir, "index.d.ts"),
    `export * from "./node/index.node";
export { default } from "./node/index.node";
`,
    "utf8"
  );
  // Note: tsc already emits `dist/node/index.d.ts` from `index.ts` and
  // `dist/node/index.node.d.ts` from `index.node.ts`. Previously this script
  // overwrote `dist/node/index.d.ts` to re-export `./index.node`, which formed
  // a cycle: `index.d.ts → index.node.d.ts → index.d.ts` (because
  // `index.node.ts` does `import from "./index"`). Leave the tsc-emitted
  // declarations in place so the types are flat.
  await writeFile(
    join(distDir, "browser", "index.d.ts"),
    `export * from "./index.browser";
export { default } from "./index.browser";
`,
    "utf8"
  );
  await writeFile(
    join(distDir, "cjs", "index.d.ts"),
    `export * from "./index.node";
export { default } from "./index.node";
`,
    "utf8"
  );
  console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);

  console.log(`🎉 All builds completed in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
