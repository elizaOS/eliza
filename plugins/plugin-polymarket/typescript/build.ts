#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function runBuild(): Promise<boolean> {
  console.log("Building @elizaos/plugin-polymarket...");

  const distDir = join(process.cwd(), "dist");

  if (existsSync(distDir)) {
    await Bun.$`rm -rf ${distDir}`;
  }

  await mkdir(distDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: ["index.ts"],
    outdir: distDir,
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: [
      "@elizaos/core",
      "@elizaos/plugin-evm",
      "dotenv",
      "fs",
      "path",
      "node:path",
      "node:fs",
      "viem",
      "viem/accounts",
      "viem/chains",
      "@polymarket/clob-client",
      "ws",
      "zod",
      "https",
      "http",
      "agentkeepalive",
      "@reflink/reflink",
    ],
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    return false;
  }

  console.log(`Build successful: ${result.outputs.length} files generated`);

  console.log("Generating TypeScript declarations...");
  const tscResult = await Bun.$`cd ${process.cwd()} && bun x tsc -p tsconfig.build.json`
    .quiet()
    .nothrow();

  if (tscResult.exitCode !== 0) {
    console.warn("Warning: TypeScript declaration generation had issues:");
    console.warn(tscResult.stderr.toString());
  }

  const indexDtsPath = join(distDir, "index.d.ts");
  if (!existsSync(indexDtsPath)) {
    await writeFile(
      indexDtsPath,
      `export * from "./index";
export { default } from "./index";
`,
      "utf8",
    );
  }

  console.log("Build complete!");
  return true;
}

runBuild()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error("Build script error:", error);
    process.exit(1);
  });
