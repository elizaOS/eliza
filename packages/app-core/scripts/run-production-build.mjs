#!/usr/bin/env node
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
import { resolveNodeExecPathFromCandidates } from "./run-node-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = resolveRepoRootFromImportMeta(import.meta.url, {
  fallbackToCwd: true,
});
const appDir = resolveMainAppDir(rootDir, "app");

/** Real Node binary — when the script is started via `bun run`, process.execPath is Bun. */
function resolveNodeExec() {
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) =>
      path.join(dir, process.platform === "win32" ? "node.exe" : "node"),
    );
  return resolveNodeExecPathFromCandidates({
    candidates: [
      process.env.npm_node_execpath,
      process.execPath,
      ...pathCandidates,
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ],
    explicitNodePath: process.env.ELIZA_NODE_PATH,
    platform: process.platform,
  });
}

const node = resolveNodeExec();

function resolveBunForScripts() {
  if (process.versions.bun) {
    return process.execPath;
  }
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "bun" : null;
}

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
const bunForScripts = resolveBunForScripts();
const pruneCdnAssetsScript = path.join(scriptDir, "prune-cdn-local-assets.mjs");
const { appAssetBaseUrl } = resolveElizaAssetBaseUrls();

await Promise.all([
  run(node, [tsdownCli, "--fail-on-warn", "false"], rootDir),
  run(node, [pluginBuildScript], appDir),
]);

async function runWriteBuildInfo() {
  if (bunForScripts) {
    await run(bunForScripts, [writeBuildInfoScript], rootDir);
    return;
  }
  await run(node, ["--import", "tsx", writeBuildInfoScript], rootDir);
}

await run(node, [viteCli, "build"], appDir);
await runWriteBuildInfo();
if (appAssetBaseUrl) {
  await run(node, [pruneCdnAssetsScript], rootDir);
}
