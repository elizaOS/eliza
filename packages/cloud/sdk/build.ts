#!/usr/bin/env bun

/**
 * Bun build script for the SDK: compiles `src/` to ESM in `dist/`, wiping any
 * prior output first. Invoked by the package's `build` script.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

async function build() {
  if (existsSync("dist")) {
    await Bun.$`node ../../scripts/rm-path-recursive.mjs dist`;
  }
  await mkdir("dist", { recursive: true });

  // Emit declarations with the TS6 compatibility compiler. Stable TS7 `tsc`
  // is the single typechecker; --noCheck skips a redundant check (#9626).
  await Bun.$`tsc6 --project tsconfig.json --noEmit false --noCheck`;
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
