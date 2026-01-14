#!/usr/bin/env bun

import { $ } from "bun";
import { buildConfig } from "./build.config";

async function build(): Promise<void> {
  console.log("🏗️  Building package...");
  await $`rm -rf dist`;

  const result = await Bun.build(buildConfig);
  if (!result.success) {
    console.error("❌ Build failed:");
    for (const message of result.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${result.outputs.length} files`);

  console.log("📝 Generating TypeScript declarations...");
  try {
    await $`tsc --project tsconfig.build.json`;
    console.log("✅ TypeScript declarations generated");
  } catch {
    console.warn(
      "⚠️ TypeScript declaration generation had issues, but continuing...",
    );
  }

  console.log("✅ Build complete!");
}

build().catch(console.error);

