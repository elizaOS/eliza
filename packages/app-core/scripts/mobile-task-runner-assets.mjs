#!/usr/bin/env node
/**
 * Stages the canonical mobile background runner into the app web asset that
 * Capacitor Background Runner actually ships (packages/app/public/runners,
 * packaged as assets/public/runners/eliza-tasks.js) plus the Android and iOS
 * platform copies, and rejects any staged copy that drifts from the source.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appCoreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MOBILE_TASK_RUNNER_SOURCE = path.join(
  appCoreRoot,
  "platforms/mobile/runners/eliza-tasks.js",
);

export const MOBILE_TASK_RUNNER_TARGETS = [
  // The copy Capacitor Background Runner ships: cap sync packages the app's
  // web assets, and the plugin loads assets/public/runners/eliza-tasks.js.
  path.join(appCoreRoot, "../app/public/runners/eliza-tasks.js"),
  path.join(
    appCoreRoot,
    "platforms/android/app/src/main/assets/runners/eliza-tasks.js",
  ),
  path.join(appCoreRoot, "platforms/ios/App/App/runners/eliza-tasks.js"),
];

export async function checkMobileTaskRunnerAssets({
  source = MOBILE_TASK_RUNNER_SOURCE,
  targets = MOBILE_TASK_RUNNER_TARGETS,
} = {}) {
  const canonical = await readFile(source);
  const drifted = [];
  for (const target of targets) {
    let staged;
    try {
      staged = await readFile(target);
    } catch {
      // error-policy:J3 A missing or unreadable staged asset is explicit drift.
      drifted.push(target);
      continue;
    }
    if (!canonical.equals(staged)) drifted.push(target);
  }
  if (drifted.length > 0) {
    throw new Error(
      `mobile task runner assets are stale: ${drifted.join(", ")}; run bun run --cwd packages/app-core mobile:runner:sync`,
    );
  }
}

export async function syncMobileTaskRunnerAssets({
  source = MOBILE_TASK_RUNNER_SOURCE,
  targets = MOBILE_TASK_RUNNER_TARGETS,
} = {}) {
  const canonical = await readFile(source);
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, canonical);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.includes("--check")) {
    await checkMobileTaskRunnerAssets();
    console.log("Mobile task runner assets match the canonical source.");
  } else {
    await syncMobileTaskRunnerAssets();
    console.log(
      "Staged the canonical mobile task runner into the app public asset and the Android and iOS platform copies.",
    );
  }
}
