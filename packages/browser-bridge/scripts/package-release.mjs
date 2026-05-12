#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBrowserBridgeReleaseMetadata,
  buildGitHubReleaseAssetDownloadUrl,
  buildGitHubReleasePageUrl,
  resolveBrowserBridgeReleaseRepository,
  resolveBrowserBridgeReleaseVersion,
  resolveBrowserBridgeStoreUrls,
  versionedArtifactName,
} from "./release-version.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");
const release = resolveBrowserBridgeReleaseVersion();
const repository = resolveBrowserBridgeReleaseRepository();
const storeUrls = resolveBrowserBridgeStoreUrls();
const metadata = buildBrowserBridgeReleaseMetadata(release);
const chromeAssetName = versionedArtifactName(
  "browser-bridge-chrome",
  "zip",
  release,
);
const safariAssetName = versionedArtifactName(
  "browser-bridge-safari",
  "zip",
  release,
);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

await run("bun", [path.join(scriptDir, "package-chrome.mjs")], {
  cwd: extensionRoot,
});
await run("bun", [path.join(scriptDir, "package-safari.mjs")], {
  cwd: extensionRoot,
});
await run("bun", [path.join(scriptDir, "package-store-assets.mjs")], {
  cwd: extensionRoot,
});

await fs.mkdir(artifactsDir, { recursive: true });

const manifest = {
  ...metadata,
  schema: "browser_bridge_release_v2",
  repository,
  releasePageUrl: buildGitHubReleasePageUrl(repository, release),
  generatedAt: new Date().toISOString(),
  chrome: {
    installKind: storeUrls.chromeWebStoreUrl
      ? "chrome_web_store"
      : "github_release",
    installUrl:
      storeUrls.chromeWebStoreUrl ??
      buildGitHubReleaseAssetDownloadUrl(repository, release, chromeAssetName),
    storeListingUrl: storeUrls.chromeWebStoreUrl,
    asset: {
      fileName: chromeAssetName,
      downloadUrl: buildGitHubReleaseAssetDownloadUrl(
        repository,
        release,
        chromeAssetName,
      ),
    },
  },
  safari: {
    installKind: storeUrls.safariAppStoreUrl
      ? "apple_app_store"
      : "github_release",
    installUrl:
      storeUrls.safariAppStoreUrl ??
      buildGitHubReleaseAssetDownloadUrl(repository, release, safariAssetName),
    storeListingUrl: storeUrls.safariAppStoreUrl,
    asset: {
      fileName: safariAssetName,
      downloadUrl: buildGitHubReleaseAssetDownloadUrl(
        repository,
        release,
        safariAssetName,
      ),
    },
  },
};

const manifestPath = path.join(
  artifactsDir,
  "browser-bridge-release-manifest.json",
);
const versionedManifestPath = path.join(
  artifactsDir,
  versionedArtifactName("browser-bridge-release-manifest", "json", release),
);
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(
  versionedManifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Wrote release manifest at ${manifestPath}`);
console.log(`Wrote versioned release manifest at ${versionedManifestPath}`);
