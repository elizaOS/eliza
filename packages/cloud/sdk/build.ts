#!/usr/bin/env bun

/**
 * Bun build script for the SDK: compiles `src/` to ESM in `dist/`, wiping any
 * prior output first. Invoked by the package's `build` script.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

export interface CloudSdkBuildOptions {
  exists?: (path: string) => boolean;
  mkdir?: typeof mkdir;
  removeDist?: () => Promise<unknown>;
  emitDeclarations?: () => Promise<unknown>;
}

export async function buildCloudSdk(options: CloudSdkBuildOptions = {}) {
  const exists = options.exists ?? existsSync;
  const mkdirFn = options.mkdir ?? mkdir;
  const removeDist =
    options.removeDist ??
    (() => Bun.$`node ../../scripts/rm-path-recursive.mjs dist`);
  const emitDeclarations =
    options.emitDeclarations ??
    (() => Bun.$`tsc6 --project tsconfig.json --noEmit false --noCheck`);

  if (exists("dist")) {
    await removeDist();
  }
  await mkdirFn("dist", { recursive: true });

  // Emit declarations with the TS6 compatibility compiler. Stable TS7 `tsc`
  // is the single typechecker; --noCheck skips a redundant check (#9626).
  await emitDeclarations();
}

if (import.meta.main) {
  buildCloudSdk().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
