#!/usr/bin/env node
// UI build: Capacitor plugins then Vite. Requires prior `bun install` (postinstall).
// ELIZA_BUILD_FULL_SETUP=1 prepends install --ignore-scripts + run-repo-setup (CI-style).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const require = createRequire(import.meta.url);

function readSourceModeMarker() {
  try {
    const raw = fs
      .readFileSync(path.join(repoRoot, ".elizaos/source-mode"), "utf8")
      .trim()
      .toLowerCase();
    if (["local", "source", "workspace"].includes(raw)) return "local";
  } catch {
    return null;
  }
  return null;
}

function shouldUseLocalElizaSource() {
  const sourceMode = (
    process.env.ELIZA_SOURCE ??
    readSourceModeMarker() ??
    "packages"
  ).toLowerCase();
  return ["local", "source", "workspace"].includes(sourceMode);
}

function resolveAppCoreRoot() {
  const localRoot = path.join(repoRoot, "eliza/packages/app-core");
  if (shouldUseLocalElizaSource() && fs.existsSync(localRoot)) {
    return localRoot;
  }
  const packageJsonPath = require.resolve("@elizaos/app-core/package.json", {
    paths: [repoRoot, appDir],
  });
  return path.dirname(packageJsonPath);
}

function resolveAppCoreScript(relativePath) {
  return path.join(resolveAppCoreRoot(), "scripts", relativePath);
}

const { resolveElizaAssetBaseUrls } = await import(
  pathToFileURL(resolveAppCoreScript("lib/asset-cdn.mjs")).href
);
const repoSetupScript = resolveAppCoreScript("run-repo-setup.mjs");
const pruneCdnAssetsScript = resolveAppCoreScript("prune-cdn-local-assets.mjs");
const bunExecutable = path
  .basename(process.execPath)
  .toLowerCase()
  .includes("bun")
  ? process.execPath
  : "bun";

const fullSetup = process.env.ELIZA_BUILD_FULL_SETUP === "1";

function run(command, args, cwd) {
  const { appAssetBaseUrl } = resolveElizaAssetBaseUrls();
  const env = {
    ...process.env,
    ...(appAssetBaseUrl
      ? {
          VITE_ASSET_BASE_URL:
            process.env.VITE_ASSET_BASE_URL ??
            process.env.ELIZA_ASSET_BASE_URL ??
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

await run(bunExecutable, ["--bun", "vite", "build"], appDir);
if (resolveElizaAssetBaseUrls().appAssetBaseUrl) {
  await run(process.execPath, [pruneCdnAssetsScript], repoRoot);
}
