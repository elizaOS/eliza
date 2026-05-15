#!/usr/bin/env bun

const externalDeps = ["@elizaos/core"];

async function build() {
  const totalStart = Date.now();

  const nodeStart = Date.now();
  console.log("Building @elizaos/plugin-edge-tts for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "node-edge-tts"],
    naming: {
      entry: "index.node.js",
    },
  });
  if (!nodeResult.success) {
    console.error(nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(`Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`);

  const browserStart = Date.now();
  console.log("Building @elizaos/plugin-edge-tts browser entry...");
  const browserResult = await Bun.build({
    entrypoints: ["src/index.browser.ts"],
    outdir: "dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: true,
    external: [...externalDeps],
  });
  if (!browserResult.success) {
    console.error(browserResult.logs);
    throw new Error("Browser build failed");
  }
  console.log(`Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`);

  const cjsStart = Date.now();
  console.log("Building @elizaos/plugin-edge-tts for Node CJS...");
  const cjsResult = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist/cjs",
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: [...externalDeps, "node-edge-tts"],
    naming: {
      entry: "index.node.js",
    },
  });
  if (!cjsResult.success) {
    console.error(cjsResult.logs);
    throw new Error("CJS build failed");
  }
  const { rename } = await import("node:fs/promises");
  await rename("dist/cjs/index.node.js", "dist/cjs/index.node.cjs");
  console.log(`CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`);

  const dtsStart = Date.now();
  console.log("Generating TypeScript declarations...");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { $ } = await import("bun");
  await $`tsc --project tsconfig.build.json`;
  await mkdir("dist/node", { recursive: true });
  await mkdir("dist/browser", { recursive: true });
  await mkdir("dist/cjs", { recursive: true });
  await writeFile(
    "dist/node/index.d.ts",
    `export * from '../index';
export { default } from '../index';
`
  );
  await writeFile(
    "dist/browser/index.d.ts",
    `export * from '../index';
export { default } from '../index';
`
  );
  await writeFile(
    "dist/cjs/index.d.ts",
    `export * from '../index';
export { default } from '../index';
`
  );
  console.log(`Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);

  console.log(`All builds finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
