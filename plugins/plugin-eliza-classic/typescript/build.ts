import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "bun";

const outdir = "./dist";

async function buildPlugin() {
  console.log("Building ELIZA Classic Plugin...\n");

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await mkdir(join(outdir, "browser"), { recursive: true });
  await mkdir(join(outdir, "node"), { recursive: true });
  await mkdir(join(outdir, "cjs"), { recursive: true });
  await mkdir(join(outdir, "models"), { recursive: true });
  await mkdir(join(outdir, "types"), { recursive: true });

  console.log("Building Node ESM...");
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

  console.log("Building Node CJS...");
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

  console.log("Generating type declarations...");
  const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  console.log("\nBuild complete!");
}

buildPlugin().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
