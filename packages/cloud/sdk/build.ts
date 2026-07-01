#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

async function build() {
  if (existsSync("dist")) {
    await Bun.$`node ../../scripts/rm-path-recursive.mjs dist`;
  }
  await mkdir("dist", { recursive: true });

  // Emit declarations only — tsgo (`typecheck`) is the single type-checker.
  // --noEmit false overrides tsconfig's noEmit; --noCheck skips the redundant
  // re-check (#9626). Verified byte-identical .d.ts vs the full-check build.
  await Bun.$`tsc --project tsconfig.json --noEmit false --noCheck`;
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
