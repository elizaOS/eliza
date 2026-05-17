#!/usr/bin/env node
/**
 * Capacitor app build orchestrator for elizaOS-based forks.
 *
 * Builds native plugins for the current host, then runs the host app's
 * `build:web` script (Vite). Reads the host app's `app.config.ts` so the
 * generic `<PREFIX>_BUILD_FULL_SETUP` / `<PREFIX>_ASSET_BASE_URL` env vars
 * resolve symmetrically with the canonical `ELIZA_*` ones.
 *
 * Usage (from the consumer repo root):
 *   node eliza/packages/app-core/scripts/build-capacitor-app.mjs
 *
 * `ELIZA_BUILD_FULL_SETUP=1` (or `<PREFIX>_BUILD_FULL_SETUP=1`) prepends
 * `bun install --ignore-scripts` + `run-repo-setup.mjs` (CI-style).
 *
 * Requires a prior `bun install` in the consumer repo so postinstall hooks
 * have run.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { resolveElizaAssetBaseUrls } from "./lib/asset-cdn.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url, {
  fallbackToCwd: true,
});
const appDir = resolveMainAppDir(repoRoot, "app");
const repoSetupScript = path.join(__dirname, "run-repo-setup.mjs");
const pruneCdnAssetsScript = path.join(__dirname, "prune-cdn-local-assets.mjs");
const buildNativePluginsScript = path.join(
  __dirname,
  "build-native-plugins.mjs",
);
const bunExecutable = path
  .basename(process.execPath)
  .toLowerCase()
  .includes("bun")
  ? process.execPath
  : "bun";

function readAppEnvPrefix() {
  const appConfigPath = path.join(appDir, "app.config.ts");
  const fallback = "ELIZA";
  if (!fs.existsSync(appConfigPath)) {
    return fallback;
  }

  const content = fs.readFileSync(appConfigPath, "utf8");
  const match = content.match(/envPrefix\s*:\s*["']([^"']+)["']/);
  const raw = match?.[1]?.trim() || fallback;
  const normalized = raw
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || fallback;
}

const APP_ENV_PREFIX = readAppEnvPrefix();
const BRANDED_BUILD_FULL_SETUP = `${APP_ENV_PREFIX}_BUILD_FULL_SETUP`;
const BRANDED_ASSET_BASE_URL = `${APP_ENV_PREFIX}_ASSET_BASE_URL`;

const fullSetup =
  process.env.ELIZA_BUILD_FULL_SETUP === "1" ||
  process.env[BRANDED_BUILD_FULL_SETUP] === "1";

function run(command, args, cwd) {
  const { appAssetBaseUrl } = resolveElizaAssetBaseUrls();
  const env = {
    ...process.env,
    ...(appAssetBaseUrl
      ? {
          VITE_ASSET_BASE_URL:
            process.env.VITE_ASSET_BASE_URL ??
            process.env.ELIZA_ASSET_BASE_URL ??
            process.env[BRANDED_ASSET_BASE_URL] ??
            appAssetBaseUrl,
        }
      : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env,
    });
    child.on("error", (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

if (fullSetup) {
  await run(bunExecutable, ["install", "--ignore-scripts"], repoRoot);
  await run(process.execPath, [repoSetupScript], repoRoot);
}

await run(process.execPath, [buildNativePluginsScript], appDir);

if (fullSetup) {
  await run(bunExecutable, ["install", "--ignore-scripts"], appDir);
}

await run(bunExecutable, ["run", "build:web"], appDir);
if (resolveElizaAssetBaseUrls().appAssetBaseUrl) {
  await run(process.execPath, [pruneCdnAssetsScript], repoRoot);
}
