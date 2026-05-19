#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-xai
 *
 * Produces:
 * - dist/node/index.node.js (ESM for Node.js)
 * - dist/browser/index.browser.js (ESM for browsers)
 * - dist/cjs/index.node.cjs (CommonJS for Node.js)
 * - dist/*.d.ts (TypeScript declarations)
 */

import { externalsFromPackageJson } from "../plugin-build-externals.ts";

const externalDeps = await externalsFromPackageJson("./package.json", {
  // zod is a transitive dep used through @elizaos/core; keep externalized.
  extra: ["zod"],
});

async function build(): Promise<void> {
  const totalStart = Date.now();

  const { mkdir } = await import("node:fs/promises");
  await mkdir("dist/node", { recursive: true });
  await mkdir("dist/browser", { recursive: true });
  await mkdir("dist/cjs", { recursive: true });

  // Node ESM build.
  //
  // We deliberately bundle `index.ts` (the real entry) rather than the
  // `index.node.ts` re-export shim. Bundling the shim triggers a Bun.build
  // codegen bug where the inlined default export is renamed to `default2`
  // but the corresponding `var default2 = ...` declaration is never emitted,
  // producing an unimportable bundle (`"default2" is not declared in this
  // file`). The output is renamed to `index.node.js` afterwards so the
  // package.json `exports` map remains stable.
  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-xai for Node (ESM)...");

  const nodeResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: "dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!nodeResult.success) {
    console.error("Node ESM build failed:", nodeResult.logs);
    throw new Error("Node ESM build failed");
  }

  {
    const { rename } = await import("node:fs/promises");
    await rename("dist/node/index.js", "dist/node/index.node.js");
    await rename("dist/node/index.js.map", "dist/node/index.node.js.map");
  }

  console.log(
    `✅ Node ESM build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`,
  );

  // Browser ESM build
  const browserStart = Date.now();
  console.log("🌐 Building @elizaos/plugin-xai for Browser...");

  const browserResult = await Bun.build({
    entrypoints: ["index.browser.ts"],
    outdir: "dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: true,
    external: externalDeps,
  });

  if (!browserResult.success) {
    console.error("Browser build failed:", browserResult.logs);
    throw new Error("Browser build failed");
  }

  console.log(
    `✅ Browser build complete in ${((Date.now() - browserStart) / 1000).toFixed(2)}s`,
  );

  // Node CJS build. Same rationale as the ESM build above: bundle `index.ts`
  // directly and rename to `index.node.cjs` to avoid the Bun.build re-export
  // shim codegen bug.
  const cjsStart = Date.now();
  console.log("🧱 Building @elizaos/plugin-xai for Node (CJS)...");

  const cjsResult = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: "dist/cjs",
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });

  if (!cjsResult.success) {
    console.error("Node CJS build failed:", cjsResult.logs);
    throw new Error("Node CJS build failed");
  }

  {
    const { rename } = await import("node:fs/promises");
    await rename("dist/cjs/index.js", "dist/cjs/index.node.cjs");
    await rename("dist/cjs/index.js.map", "dist/cjs/index.node.cjs.map");
  }

  console.log(
    `✅ Node CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`,
  );

  // TypeScript declarations
  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");

  const { writeFile } = await import("node:fs/promises");
  const { $ } = await import("bun");

  await $`tsc --project tsconfig.build.json`;

  // Create re-export declaration files for each entry point
  const reexportDeclaration = `export * from '../index';
export { default } from '../index';
`;

  await writeFile("dist/node/index.d.ts", reexportDeclaration);
  await writeFile("dist/browser/index.d.ts", reexportDeclaration);
  await writeFile("dist/cjs/index.d.ts", reexportDeclaration);

  console.log(
    `✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`,
  );

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(2);
  console.log(`🎉 All builds finished in ${totalTime}s`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
