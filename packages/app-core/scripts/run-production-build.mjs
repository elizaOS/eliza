#!/usr/bin/env bun
/**
 * Full production build with maximal safe parallelism:
 * 1. tsdown (root dist) ∥ Capacitor plugin-build
 * 2. vite build (packages/app)
 * 3. write-build-info (dist metadata)
 *
 * Requires prior `bun install` / postinstall.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { resolveElizaAssetBaseUrls } from "./lib/asset-cdn.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = resolveRepoRootFromImportMeta(import.meta.url, {
  fallbackToCwd: true,
});
const appDir = resolveMainAppDir(rootDir, "app");

function resolveBunExec() {
  if (process.versions.bun) {
    return process.execPath;
  }
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "bun";
  throw new Error(
    "Bun is required for the production build. Install the repository-pinned Bun runtime and rerun bun install.",
  );
}

const bun = resolveBunExec();

function run(executable, args, cwd) {
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
    const child = spawn(executable, args, {
      cwd,
      stdio: "inherit",
      env,
      shell: false,
    });
    child.on("error", (error) => {
      reject(new Error(`${executable} failed to start: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`process exited with signal ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`process exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

function resolveTsdownCli() {
  const candidates = [
    path.join(rootDir, "node_modules", "tsdown", "dist", "run.mjs"),
    path.join(process.cwd(), "node_modules", "tsdown", "dist", "run.mjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  throw new Error("tsdown not found under node_modules; run bun install");
}

function resolveViteCli() {
  for (const base of [appDir, rootDir, process.cwd()]) {
    const p = path.join(base, "node_modules", "vite", "bin", "vite.js");
    if (fs.existsSync(p)) {
      return p;
    }
  }
  throw new Error("vite CLI not found; run bun install");
}

const tsdownCli = resolveTsdownCli();
const viteCli = resolveViteCli();
const pluginBuildScript = path.join(scriptDir, "build-native-plugins.mjs");
const writeBuildInfoScript = fs.existsSync(
  path.join(rootDir, "packages", "scripts", "write-build-info.ts"),
)
  ? path.join(rootDir, "packages", "scripts", "write-build-info.ts")
  : path.join(rootDir, "scripts", "write-build-info.ts");
const pruneCdnAssetsScript = path.join(scriptDir, "prune-cdn-local-assets.mjs");
const { appAssetBaseUrl } = resolveElizaAssetBaseUrls();

await Promise.all([
  run(bun, [tsdownCli, "--fail-on-warn", "false"], rootDir),
  run(bun, [pluginBuildScript], appDir),
]);

async function runWriteBuildInfo() {
  await run(bun, [writeBuildInfoScript], rootDir);
}

await run(bun, [viteCli, "build"], appDir);
await runWriteBuildInfo();
if (appAssetBaseUrl) {
  await run(bun, [pruneCdnAssetsScript], rootDir);
}
