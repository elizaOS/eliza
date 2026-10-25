#!/usr/bin/env node
/**
 * Builds install-required distributions through Turbo's dependency graph and
 * content cache. Existing dist files alone never establish source freshness.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildOnInstallPackages } from "./lib/script-metadata.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const tasks = resolveBuildOnInstallPackages({ repoRoot }).map(
  ({ name, script = "build" }) => `${name}#${script}`,
);

if (tasks.length > 0) {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "packages/scripts/run-turbo.ts"), "run", ...tasks],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`Install builds terminated by ${result.signal}`);
  }
  process.exitCode = result.status ?? 1;
}
