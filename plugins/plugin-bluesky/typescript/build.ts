import { build } from "bun";

const isWatch = process.argv.includes("--watch");

async function buildPlugin() {
  console.log("Building BlueSky plugin...");

  await build({
    entrypoints: ["./index.node.ts"],
    outdir: "../dist/node",
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [
      "@elizaos/core",
      "@atproto/api",
      "@atproto/identity",
      "@atproto/lexicon",
      "@atproto/syntax",
      "@atproto/xrpc",
      "lru-cache",
      "zod",
    ],
  });

  await build({
    entrypoints: ["./index.browser.ts"],
    outdir: "../dist/browser",
    target: "browser",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: ["@elizaos/core", "zod"],
  });

  console.log("Build complete!");
}

if (isWatch) {
  console.log("Watching for changes...");
}
await buildPlugin();
