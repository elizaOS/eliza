#!/usr/bin/env bun

import { $ } from "bun";
import { buildConfig } from "./build.config";

async function build(): Promise<void> {
  await $`rm -rf dist`;

  const result = await Bun.build(buildConfig);
  if (!result.success) {
    for (const message of result.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  try {
    await $`tsc --project tsconfig.build.json`;
  } catch {
    // declaration generation is best-effort
  }
}

build().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
