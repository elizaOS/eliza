#!/usr/bin/env bun

import { $ } from "bun";

// All dependencies should be external - they'll be installed at runtime
const externalDeps = [
  "@elizaos/core",
  "mineflayer",
  "mineflayer-pathfinder",
  "minecraft-data",
  "prismarine-item",
  "vec3",
  "ws",
  "zod",
];

async function build(): Promise<void> {
  await $`rm -rf dist`;
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    external: externalDeps,
  });

  if (!result.success) {
    for (const log of result.logs) {
      // bun's log objects stringify well enough for terminal output
      console.error(log);
    }
    process.exit(1);
  }

  try {
    await $`tsc --project tsconfig.json --noEmit`;
  } catch {
    // Keep server build resilient; runtime is more important than d.ts here.
  }
}

build().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});

