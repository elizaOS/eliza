#!/usr/bin/env bun
/**
 * Build script for plugin-prose
 */

import { $ } from "bun";

async function build() {
  console.log("[build] Starting plugin-prose build...");

  // Clean dist
  await $`rm -rf dist`.quiet().nothrow();

  // Build ESM (Node.js)
  console.log("[build] Building ESM...");
  await Bun.build({
    entrypoints: ["./index.node.ts"],
    outdir: "./dist/esm",
    target: "node",
    format: "esm",
    sourcemap: "external",
    external: ["@elizaos/core"],
  });

  // Rename to .js
  await $`mv dist/esm/index.node.js dist/esm/index.js`.quiet().nothrow();
  await $`mv dist/esm/index.node.js.map dist/esm/index.js.map`.quiet().nothrow();

  // Build CJS (Node.js)
  console.log("[build] Building CJS...");
  await Bun.build({
    entrypoints: ["./index.node.ts"],
    outdir: "./dist/cjs",
    target: "node",
    format: "cjs",
    sourcemap: "external",
    external: ["@elizaos/core"],
  });

  // Rename to .cjs
  await $`mv dist/cjs/index.node.js dist/cjs/index.cjs`.quiet().nothrow();
  await $`mv dist/cjs/index.node.js.map dist/cjs/index.cjs.map`.quiet().nothrow();

  // Build Browser
  console.log("[build] Building Browser bundle...");
  await Bun.build({
    entrypoints: ["./index.browser.ts"],
    outdir: "./dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    external: ["@elizaos/core"],
  });

  // Rename browser
  await $`mv dist/browser/index.browser.js dist/browser/index.js`.quiet().nothrow();
  await $`mv dist/browser/index.browser.js.map dist/browser/index.js.map`.quiet().nothrow();

  // Generate type declarations
  console.log("[build] Generating type declarations...");
  await $`tsc --project tsconfig.build.json`.quiet().nothrow();

  console.log("[build] Build complete!");
}

build().catch((err) => {
  console.error("[build] Build failed:", err);
  process.exit(1);
});
