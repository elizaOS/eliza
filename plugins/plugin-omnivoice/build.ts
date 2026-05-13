#!/usr/bin/env bun
/**
 * Dual build script for @elizaos/plugin-omnivoice (Node + Browser stub).
 * Mirrors plugins/plugin-edge-tts/build.ts.
 */

const externalDeps = ["@elizaos/core"];

async function build() {
  const totalStart = Date.now();

  console.log("Building @elizaos/plugin-omnivoice for Node...");
  const nodeStart = Date.now();
  const nodeResult = await Bun.build({
    entrypoints: ["src/index.node.ts"],
    outdir: "dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "bun:ffi"],
    naming: { entry: "index.node.js" },
  });
  if (!nodeResult.success) {
    console.error(nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(
    `Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`,
  );

  console.log("Building @elizaos/plugin-omnivoice for Browser (stub)...");
  const browserStart = Date.now();
  const browserResult = await Bun.build({
    entrypoints: ["src/index.browser.ts"],
    outdir: "dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: true,
    external: [...externalDeps],
    naming: { entry: "index.browser.js" },
  });
  if (!browserResult.success) {
    console.error(browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(
    `Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`,
  );

  console.log("Generating TypeScript declarations...");
  const dtsStart = Date.now();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { $ } = await import("bun");
  try {
    await $`tsc --project tsconfig.build.json`;
  } catch (_e) {
    console.warn("tsc failed, writing stub declarations");
  }
  await mkdir("dist/node", { recursive: true });
  await mkdir("dist/browser", { recursive: true });
  const stub = `export * from "@elizaos/core";\n`;
  await writeFile("dist/index.d.ts", stub);
  await writeFile(
    "dist/node/index.d.ts",
    `export * from '../index';\nexport { default } from '../index';\n`,
  );
  await writeFile(
    "dist/browser/index.d.ts",
    `export * from '../index';\nexport { default } from '../index';\n`,
  );
  console.log(
    `Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`,
  );

  console.log(
    `All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`,
  );
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
