#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
/**
 * Build script for plugin-forms TypeScript
 */
import { build } from "bun";

const outdir = join(import.meta.dir, "..", "dist");

// Clean output directory
if (existsSync(outdir)) {
  rmSync(outdir, { recursive: true });
}
mkdirSync(outdir, { recursive: true });
mkdirSync(join(outdir, "node"), { recursive: true });

// Build for Node.js
await build({
  entrypoints: [join(import.meta.dir, "index.ts")],
  outdir: join(outdir, "node"),
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: process.env.NODE_ENV === "production",
  external: ["@elizaos/core", "uuid", "zod"],
  naming: {
    entry: "index.node.js",
  },
});

console.log("✅ Build completed successfully");
