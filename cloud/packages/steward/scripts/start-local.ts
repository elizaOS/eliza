#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const requiredArtifacts = ["packages/redis/dist/index.js", "packages/shared/dist/index.js"];

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (requiredArtifacts.some((artifact) => !existsSync(artifact))) {
  console.log("[steward] Building workspace packages required for embedded mode...");
  run("bunx", ["turbo", "run", "build", "--filter=@stwd/api..."]);
}

run("bun", ["run", "packages/api/src/embedded.ts"]);
