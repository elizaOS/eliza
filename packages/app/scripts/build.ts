#!/usr/bin/env node
/**
 * Builds the app's plugin and Vite artifacts, stamps their source revision,
 * verifies emitted shell contracts, and optionally performs CI-style setup.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removePublicBuildStamp, shouldSkipBuildStamp } from "./build-stamp.ts";
import { resolveElizaAssetBaseUrls } from "./lib/asset-cdn.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const pruneCdnAssetsScript = path.join(
  repoRoot,
  "packages",
  "app",
  "scripts",
  "prune-cdn-local-assets.ts",
);
const viewportMetaVerifier = path.join(
  appDir,
  "scripts",
  "verify-viewport-meta.ts",
);
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
            process.env.VITE_ASSET_BASE_URL ?? appAssetBaseUrl,
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

function stampBuildInfo() {
  if (shouldSkipBuildStamp()) {
    removePublicBuildStamp(appDir);
    return;
  }
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (!commit) return;
    const now = new Date();
    const builtAt = now.toISOString();
    const stampDate = now.toLocaleString("en-US", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const label = `${commit} \u00b7 ${stampDate}`;
    const outDir = path.join(appDir, "public");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "build-info.json"),
      `${JSON.stringify({ commit, builtAt, label })}\n`,
    );
  } catch {
    // git absent or non-repo build context — skip the stamp silently.
  }
}

async function main() {
  if (fullSetup) {
    await run(bunExecutable, ["install", "--ignore-scripts"], repoRoot);
    await run(bunExecutable, ["run", "postinstall"], repoRoot);
  }

  stampBuildInfo();

  await run(
    process.execPath,
    [path.join(__dirname, "build-native-plugins.ts")],
    appDir,
  );

  await run(
    bunExecutable,
    ["--bun", "vite", "build", "--configLoader", "runner"],
    appDir,
  );
  await run(process.execPath, [viewportMetaVerifier], appDir);
  if (resolveElizaAssetBaseUrls().appAssetBaseUrl) {
    await run(process.execPath, [pruneCdnAssetsScript], repoRoot);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  await main();
}
