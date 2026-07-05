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
 * It resolves the packaged Windows launcher, persists the reusable launcher
 * path requested by `ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE`, and runs the
 * existing `electrobun-windows-startup` Playwright smoke on Windows. It also
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

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const defaultArtifactsDir = path.join(
  repoRoot,
  "packages",
  "app-core",
  "platforms",
  "electrobun",
  "artifacts",
);
const defaultBuildDir = path.join(
  repoRoot,
  "packages",
  "app-core",
  "platforms",
  "electrobun",
  "build",
);

function fail(message) {
  // Emit on both streams so the precondition reason is captured regardless of
  // how a harness pipes the child's stdio (stderr is the primary channel).
  const line = `[test:desktop:packaged:windows] ${message}\n`;
  process.stderr.write(line);
  process.stdout.write(line);
  process.exit(1);
}

async function findFiles(root, matcher) {
  const found = [];
  async function walk(currentDir) {
    const entries = await fs
      .readdir(currentDir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && matcher(fullPath)) {
        found.push(fullPath);
      }
    }
  }

  if (existsSync(root)) {
    await walk(root);
  }
  return found;
}

async function newestPath(paths) {
  const withStats = await Promise.all(
    paths.map(async (candidate) => ({
      path: candidate,
      stat: await fs.stat(candidate),
    })),
  );
  withStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return await fs.realpath(withStats[0].path);
}

async function findLauncherExe(root) {
  const matches = await findFiles(
    root,
    (fullPath) => path.basename(fullPath).toLowerCase() === "launcher.exe",
  );
  return matches.length > 0 ? newestPath(matches) : null;
}

async function resolveWindowsLauncher() {
  const explicit =
    process.env.ELIZA_TEST_PACKAGED_LAUNCHER_PATH?.trim() ||
    process.env.ELIZA_TEST_WINDOWS_LAUNCHER_PATH?.trim();
  if (explicit) {
    await fs.access(explicit);
    return await fs.realpath(explicit);
  }

  const buildDir =
    process.env.ELIZA_TEST_WINDOWS_BUILD_DIR?.trim() || defaultBuildDir;
  const artifactsDir =
    process.env.ELIZA_TEST_WINDOWS_ARTIFACTS_DIR?.trim() || defaultArtifactsDir;

  const builtLauncher = await findLauncherExe(buildDir);
  if (builtLauncher) return builtLauncher;

  const artifactLauncher = await findLauncherExe(artifactsDir);
  if (artifactLauncher) return artifactLauncher;

  const tarballs = await findFiles(artifactsDir, (fullPath) =>
    fullPath.endsWith(".tar.zst"),
  );
  if (tarballs.length === 0) {
    fail(
      `no Windows launcher.exe or .tar.zst packaged artifact found under ${buildDir} or ${artifactsDir}`,
    );
  }

  const archivePath = await newestPath(tarballs);
  const extractParent =
    process.env.ELIZA_TEST_WINDOWS_LAUNCHER_DIR?.trim() ||
    (await fs.mkdtemp(path.join(os.tmpdir(), "eliza-windows-packaged-")));
  await fs.mkdir(extractParent, { recursive: true });
  execFileSync("tar", [
    "--force-local",
    "-xf",
    archivePath,
    "-C",
    extractParent,
  ]);

  const extractedLauncher = await findLauncherExe(extractParent);
  if (!extractedLauncher) {
    fail(`failed to find launcher.exe after extracting ${archivePath}`);
  }
  return extractedLauncher;
}

async function persistLauncherPath(launcherPath) {
  const launcherPathFile =
    process.env.ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE?.trim();
  if (!launcherPathFile) return;
  await fs.mkdir(path.dirname(launcherPathFile), { recursive: true });
  await fs.writeFile(launcherPathFile, `${launcherPath}\n`, "utf8");
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

const launcherPath = await resolveWindowsLauncher();
await persistLauncherPath(launcherPath);

const child = spawn(
  process.execPath,
  [
    "scripts/run-ui-playwright.mjs",
    "--config",
    "playwright.electrobun.packaged.config.ts",
    "test/electrobun-packaged/electrobun-windows-startup.e2e.spec.ts",
  ],
  {
    cwd: appDir,
    env: {
      ...process.env,
      ELIZA_TEST_WINDOWS_LAUNCHER_PATH: launcherPath,
    },
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
