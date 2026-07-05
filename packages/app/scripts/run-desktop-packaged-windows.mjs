#!/usr/bin/env node
/**
 * Windows packaged-desktop smoke lane (`test:desktop:packaged:windows`).
 *
 * This is the canonical entry point invoked by three call sites that used to
 * reference a non-existent script name:
 *   - .github/workflows/release-electrobun.yml  ("Smoke test packaged Windows app")
 *   - packages/app-core/scripts/release-check.ts
 *   - packages/app-core/test/regression-matrix.json (desktop-packaged-windows)
 *
 * It runs the existing packaged Windows PowerShell smoke on Windows, preserving
 * the workflow's `ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE` handoff contract, and
 * — critically — fails with a NON-ZERO exit and a truthful precondition message
 * on any non-Windows host, instead of the previous `error: Script not found`
 * (invisible break) or a silent green "skipped" run. A release smoke lane that
 * cannot actually run must report that as a failure so the packaged-Windows
 * loop is never reported green with nothing executed.
 *
 * The `ELIZA_TEST_WINDOWS_*` env contract set by the workflow step (install
 * dir, launcher dir, launcher-path file, artifacts/build dirs) is inherited by
 * the delegated Playwright process unchanged.
 */

import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const smokeScript = path.join(
  repoRoot,
  "packages",
  "app-core",
  "platforms",
  "electrobun",
  "scripts",
  "smoke-test-windows.ps1",
);

function fail(message) {
  // Emit on both streams so the precondition reason is captured regardless of
  // how a harness pipes the child's stdio (stderr is the primary channel).
  const line = `[test:desktop:packaged:windows] ${message}\n`;
  process.stderr.write(line);
  process.stdout.write(line);
  process.exit(1);
}

if (process.platform !== "win32") {
  // Truthful precondition failure: there is no Windows build to smoke-test on a
  // non-Windows host. Exit non-zero (NOT "Script not found", NOT a green skip)
  // so the release pipeline sees the lane did not run.
  fail(
    `packaged Windows smoke test requires a windows host (host is ${process.platform}); ` +
      `run this lane on a Windows runner with a packaged build present.`,
  );
}

try {
  accessSync(smokeScript);
} catch {
  fail(`missing Windows smoke script: ${smokeScript}`);
}

const child = spawn(
  "pwsh",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", smokeScript],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  fail(`failed to launch the packaged Windows lane: ${error.message}`);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
