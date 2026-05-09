#!/usr/bin/env bun

/**
 * Build script for @elizaos/plugin-agent-orchestrator (Node + Browser)
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const externalDeps = [
  "@elizaos/core",
  "@elizaos/agent",
  "@elizaos/app-core",
  "@elizaos/app-task-coordinator",
  "coding-agent-adapters",
  "drizzle-orm",
  "pty-console",
  "pty-state-capture",
  "pty-manager",
  "git-workspace-service",
];

async function build() {
  const totalStart = Date.now();
  const distDir = join(process.cwd(), "dist");

  const nodeStart = Date.now();
  console.log("🔨 Building @elizaos/plugin-agent-orchestrator for Node...");
  const nodeResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "node"),
    target: "node",
    format: "esm",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!nodeResult.success) {
    console.error("Node build failed:", nodeResult.logs);
    throw new Error("Node build failed");
  }
  console.log(
    `✅ Node build complete in ${((Date.now() - nodeStart) / 1000).toFixed(2)}s`,
  );

  // No browser build: this plugin includes Node-only services (PTY,
  // workspace lifecycle, child_process spawn). Browser callers should
  // only depend on the type definitions; the package's `exports` field
  // points the browser condition at the same node bundle for resolution
  // purposes but the runtime is Node/bun.

  const cjsStart = Date.now();
  console.log(
    "🧱 Building @elizaos/plugin-agent-orchestrator for Node (CJS)...",
  );
  const cjsResult = await Bun.build({
    entrypoints: ["index.node.ts"],
    outdir: join(distDir, "cjs"),
    target: "node",
    format: "cjs",
    sourcemap: "external",
    minify: false,
    external: externalDeps,
  });
  if (!cjsResult.success) {
    console.error("CJS build failed:", cjsResult.logs);
    throw new Error("CJS build failed");
  }
  try {
    const { rename } = await import("node:fs/promises");
    await rename(
      join(distDir, "cjs", "index.node.js"),
      join(distDir, "cjs", "index.node.cjs"),
    );
  } catch (e) {
    console.warn("CJS rename step warning:", e);
  }
  console.log(
    `✅ CJS build complete in ${((Date.now() - cjsStart) / 1000).toFixed(2)}s`,
  );

  const dtsStart = Date.now();
  console.log("📝 Generating TypeScript declarations...");
  const { $ } = await import("bun");
  await $`tsc --project tsconfig.build.json`;

  const nodeDir = join(distDir, "node");
  const cjsDir = join(distDir, "cjs");

  if (!existsSync(nodeDir)) await mkdir(nodeDir, { recursive: true });
  if (!existsSync(cjsDir)) await mkdir(cjsDir, { recursive: true });

  const rootAlias = `export * from "./node/index";\nexport { default } from "./node/index";\n`;
  await writeFile(join(distDir, "index.d.ts"), rootAlias, "utf8");

  const nodeAlias = `export * from "./index.node";\nexport { default } from "./index.node";\n`;
  await writeFile(join(nodeDir, "index.d.ts"), nodeAlias, "utf8");

  const cjsAlias = `export * from "./index.node";\nexport { default } from "./index.node";\n`;
  await writeFile(join(cjsDir, "index.d.ts"), cjsAlias, "utf8");

  console.log(
    `✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`,
  );
  console.log(
    `🎉 All builds completed in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`,
  );
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
