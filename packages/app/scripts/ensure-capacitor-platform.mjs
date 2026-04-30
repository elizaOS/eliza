#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const platformDir = path.join(appRoot, platform);

if (fs.existsSync(platformDir)) {
  console.log(`[ensure-capacitor-platform] ${platform} already added`);
  process.exit(0);
}

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

if (!fs.existsSync(platformDir)) {
  console.error(
    `[ensure-capacitor-platform] capacitor add ${platform} completed without creating ${platformDir}`,
  );
  process.exit(1);
}

console.log(`[ensure-capacitor-platform] added ${platform}`);
