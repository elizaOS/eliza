import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "bun";

const outdir = "./dist";

async function buildPlugin() {
  console.log("🔨 Building Knowledge Plugin...\n");

  // Clean dist
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await mkdir(join(outdir, "browser"), { recursive: true });
  await mkdir(join(outdir, "node"), { recursive: true });
  await mkdir(join(outdir, "cjs"), { recursive: true });

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
    external: [
      "@elizaos/core",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@ai-sdk/openai",
      "@openrouter/ai-sdk-provider",
      "@tanstack/react-query",
      "ai",
      "clsx",
      "dotenv",
      "lucide-react",
      "mammoth",
      "multer",
      "react",
      "react-dom",
      "react-force-graph-2d",
      "tailwind-merge",
      "unpdf",
      "zod",
    ],
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
    external: [
      "@elizaos/core",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@ai-sdk/openai",
      "@openrouter/ai-sdk-provider",
      "@tanstack/react-query",
      "ai",
      "clsx",
      "dotenv",
      "lucide-react",
      "mammoth",
      "multer",
      "react",
      "react-dom",
      "react-force-graph-2d",
      "tailwind-merge",
      "unpdf",
      "zod",
    ],
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
    external: [
      "@elizaos/core",
      "@tanstack/react-query",
      "ai",
      "clsx",
      "lucide-react",
      "react",
      "react-dom",
      "react-force-graph-2d",
      "tailwind-merge",
      "zod",
    ],
  });

  // Generate declarations using tsc
  console.log("📝 Generating type declarations...");
  const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  // Copy frontend assets if they exist (from vite build)
  console.log("📋 Copying frontend assets...");
  const frontendDist = join(dirname(import.meta.path), "dist-frontend");
  if (existsSync(frontendDist)) {
    await cp(frontendDist, join(outdir, "assets"), { recursive: true });
    console.log("  ✅ Frontend assets copied");
  }

  console.log("\n✅ Build complete!");
}

buildPlugin().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
