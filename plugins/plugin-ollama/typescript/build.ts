import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "bun";

const ROOT = resolve(dirname(import.meta.path));
const DIST = join(ROOT, "dist");

if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}
mkdirSync(DIST, { recursive: true });
mkdirSync(join(DIST, "node"), { recursive: true });
mkdirSync(join(DIST, "cjs"), { recursive: true });

console.log("Building Node.js ESM bundle...");
await build({
  entrypoints: [join(ROOT, "index.ts")],
  outdir: join(DIST, "node"),
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: ["@elizaos/core", "ai", "ollama-ai-provider"],
  naming: {
    entry: "index.node.js",
  },
});

console.log("Building CJS bundle...");
await build({
  entrypoints: [join(ROOT, "index.ts")],
  outdir: join(DIST, "cjs"),
  target: "node",
  format: "cjs",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: ["@elizaos/core", "ai", "ollama-ai-provider"],
  naming: {
    entry: "index.node.cjs",
  },
});

console.log("Build complete!");
