/**
 * Build script for ELIZA Classic Plugin
 */
import { build } from "bun";
import { rm, mkdir, copyFile } from "fs/promises";
import { join } from "path";

const outdir = "./dist";

async function buildPlugin() {
  console.log("🔨 Building ELIZA Classic Plugin...\n");

  // Clean dist
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await mkdir(join(outdir, "browser"), { recursive: true });
  await mkdir(join(outdir, "node"), { recursive: true });
  await mkdir(join(outdir, "cjs"), { recursive: true });
  await mkdir(join(outdir, "models"), { recursive: true });
  await mkdir(join(outdir, "types"), { recursive: true });

  // Build Node ESM
  console.log("📦 Building Node ESM...");
  await build({
    entrypoints: ["./index.node.ts"],
    outdir: join(outdir, "node"),
    target: "node",
    format: "esm",
    sourcemap: "linked",
    minify: false,
    naming: "[name].js",
    external: ["@elizaos/core"],
  });

  // Build Node CJS
  console.log("📦 Building Node CJS...");
  await build({
    entrypoints: ["./index.node.ts"],
    outdir: join(outdir, "cjs"),
    target: "node",
    format: "cjs",
    sourcemap: "linked",
    minify: false,
    naming: "[name].cjs",
    external: ["@elizaos/core"],
  });

  // Build Browser ESM
  console.log("📦 Building Browser ESM...");
  await build({
    entrypoints: ["./index.browser.ts"],
    outdir: join(outdir, "browser"),
    target: "browser",
    format: "esm",
    sourcemap: "linked",
    minify: false,
    naming: "[name].js",
    external: ["@elizaos/core"],
  });

  // Generate declarations using tsc
  console.log("📝 Generating type declarations...");
  const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  console.log("\n✅ Build complete!");
}

buildPlugin().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});





