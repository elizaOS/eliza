#!/usr/bin/env node
// UI build: Capacitor plugins then Vite. Requires prior `bun install` (postinstall).
// ELIZA_BUILD_FULL_SETUP=1 prepends install --ignore-scripts + run-repo-setup (CI-style).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveElizaAssetBaseUrls } from "../../../packages/app-core/scripts/lib/asset-cdn.mjs";
import { normalizeEnvPrefix } from "../src/env-prefix.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const repoSetupScript = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "run-repo-setup.mjs",
);
const pruneCdnAssetsScript = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "prune-cdn-local-assets.mjs",
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
  try {
    return normalizeEnvPrefix(raw || fallback);
  } catch {
    return normalizeEnvPrefix(fallback);
  }
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

await run(process.execPath, [path.join(__dirname, "plugin-build.mjs")], appDir);

if (fullSetup) {
  await run(bunExecutable, ["install", "--ignore-scripts"], appDir);
}

await run(bunExecutable, ["run", "build:web"], appDir);
if (resolveElizaAssetBaseUrls().appAssetBaseUrl) {
  await run(process.execPath, [pruneCdnAssetsScript], repoRoot);
}
