#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

async function build() {
  if (existsSync("dist")) {
    await Bun.$`node ../scripts/rm-path-recursive.mjs dist`;
  }
  await mkdir("dist", { recursive: true });

  await Bun.$`tsc --project tsconfig.json --noEmit false`;
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
