#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const result = spawnSync(
  process.execPath,
  [path.join(repoRoot, "packages/scripts/build-views.mjs"), ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" },
  },
);

process.exit(result.status ?? 1);
