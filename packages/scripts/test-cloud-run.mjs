#!/usr/bin/env node
// Cross-platform replacement for the previous `test:cloud` shell pipeline,
// which used `printf '...\n'` (broken under bun's embedded shell on Windows
// — outputs literal `n` instead of newlines) and required POSIX-shell
// `$OLDPWD` semantics.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const stagingDir = path.join(repoRoot, ".tmp", "cloud-unit-bun");

mkdirSync(stagingDir, { recursive: true });

writeFileSync(
  path.join(stagingDir, "bunfig.toml"),
  "[test]\ntimeout = 120000\ncoverage = false\n",
);

const env = {
  ...process.env,
  SKIP_DB_DEPENDENT: "1",
  SKIP_SERVER_CHECK: "true",
};

const cloudSharedSrc = path.join(repoRoot, "packages", "cloud-shared", "src");
const cloudApiTests = path.join(repoRoot, "packages", "cloud-api", "__tests__");

const result = spawnSync(
  "bun",
  [
    "test",
    cloudSharedSrc,
    cloudApiTests,
    "--timeout",
    "120000",
    "--isolate",
  ],
  {
    cwd: stagingDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
