#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "bun";

const outDir = join(import.meta.dir, "dist");

// Clean output directory
try {
  rmSync(outDir, { recursive: true, force: true });
} catch {
  // Directory doesn't exist, ignore
}
mkdirSync(outDir, { recursive: true });

// Build Node.js version (ESM)
const nodeResult = await build({
  entrypoints: [join(import.meta.dir, "src", "index.ts")],
  outdir: outDir,
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  minify: false,
  external: ["@elizaos/core", "drizzle-orm"],
  naming: {
    entry: "[name].js",
  },
});

if (!nodeResult.success) {
  console.error("Node build failed:", nodeResult.logs);
  process.exit(1);
}

// Generate TypeScript declarations
console.log("📝 Generating TypeScript declarations...");
const tscProcess = spawn("bunx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: import.meta.dir,
  stdio: "inherit",
});

await new Promise<void>((resolve, reject) => {
  tscProcess.on("close", (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`TypeScript compilation failed with code ${code}`));
    }
  });
});

console.log("✅ Build completed successfully");
console.log(`   Output: ${outDir}/index.js`);
