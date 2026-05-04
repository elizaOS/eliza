#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMainAppDir } from "../../app-core/scripts/lib/app-dir.mjs";
import {
  isCapacitorPlatformReady,
  syncPlatformTemplateFiles,
} from "../../app-core/scripts/lib/capacitor-platform-templates.mjs";
import { resolveRepoRootFromImportMeta } from "../../app-core/scripts/lib/repo-root.mjs";

const validPlatforms = new Set(["android", "ios"]);
const platform = process.argv[2];

if (!validPlatforms.has(platform)) {
  console.error(
    `[ensure-capacitor-platform] expected one of ${Array.from(validPlatforms).join(", ")}, received ${platform ?? "<missing>"}`,
  );
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const appDirForTemplates = resolveMainAppDir(repoRoot, "app");
const platformDir = path.join(appRoot, platform);

function materializeTemplates() {
  return syncPlatformTemplateFiles(platform, {
    repoRootValue: repoRoot,
    appDirValue: appDirForTemplates,
    log: console.log,
  });
}

materializeTemplates();

if (isCapacitorPlatformReady(platform, { appDirValue: appDirForTemplates })) {
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

if (!isCapacitorPlatformReady(platform, { appDirValue: appDirForTemplates })) {
  console.error(
    `[ensure-capacitor-platform] ${platform} project is incomplete after template sync / cap add.`,
  );
  process.exit(1);
}

console.log(`[ensure-capacitor-platform] ${platform} ready`);
