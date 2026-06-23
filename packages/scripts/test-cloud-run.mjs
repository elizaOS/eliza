#!/usr/bin/env node

// Cross-platform replacement for the previous `test:cloud` shell pipeline,
// which used `printf '...\n'` (broken under bun's embedded shell on Windows
// — outputs literal `n` instead of newlines) and required POSIX-shell
// `$OLDPWD` semantics.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
// cloud-tests.yml already triggers on `packages/scripts/cloud/**`, but nothing
// here ran those tests — the daemon/admin guards (e.g. the provisioning-worker
// env-reconcile regression test for #8756) silently never executed. Include the
// directory so the path trigger actually exercises them.
const cloudScriptsTests = path.join(repoRoot, "packages", "scripts", "cloud");

const result = spawnSync(
  "bun",
  [
    "test",
    cloudSharedSrc,
    cloudApiTests,
    cloudScriptsTests,
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
