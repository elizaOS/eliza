#!/usr/bin/env node
/**
 * Runs the deterministic, platform-independent release contract tests used by
 * pull requests before the signed multi-platform release workflow is allowed.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "../../..");
const result = spawnSync(
  "bun",
  [
    "test",
    "packages/app-core/scripts/release-check-mac-stager.test.ts",
    "packages/scripts/__tests__/release-electrobun-tag-binding.test.ts",
    "packages/scripts/__tests__/release-workflow-authority.test.ts",
    "packages/scripts/__tests__/release-workflow.test.ts",
  ],
  { cwd: repoRoot, env: process.env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
