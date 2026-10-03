#!/usr/bin/env node
/**
 * Command-line helper for the Ensure Capacitor Platform app packaging, mobile,
 * or Playwright automation lane.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveMainAppDir } from "./lib/app-dir.ts";
import {
  isCapacitorPlatformReady,
  syncPlatformTemplateFiles,
} from "./lib/capacitor-platform-templates.ts";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.ts";

const validPlatforms = new Set(["android", "ios"]);
const platform = process.argv[2];

if (!validPlatforms.has(platform)) {
  console.error(
    `[ensure-capacitor-platform] expected one of ${Array.from(validPlatforms).join(", ")}, received ${platform ?? "<missing>"}`,
  );
  process.exit(1);
}

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const appRoot = resolveMainAppDir(repoRoot, "app");
const platformDir = path.join(appRoot, platform);

function materializeTemplates() {
  return syncPlatformTemplateFiles(platform, {
    repoRootValue: repoRoot,
    appDirValue: appRoot,
    log: console.log,
  });
}

materializeTemplates();

if (isCapacitorPlatformReady(platform, { appDirValue: appRoot })) {
  console.log(`[ensure-capacitor-platform] ${platform} ready`);
  process.exit(0);
}

if (!fs.existsSync(platformDir)) {
  const result = spawnSync("bunx", ["cap", "add", platform], {
    cwd: appRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  materializeTemplates();

  if (!fs.existsSync(platformDir)) {
    console.error(
      `[ensure-capacitor-platform] capacitor add ${platform} completed without creating ${platformDir}`,
    );
    process.exit(1);
  }
}

if (!isCapacitorPlatformReady(platform, { appDirValue: appRoot })) {
  console.error(
    `[ensure-capacitor-platform] ${platform} project is missing required files after template sync / cap add.`,
  );
  process.exit(1);
}

console.log(`[ensure-capacitor-platform] ${platform} ready`);
