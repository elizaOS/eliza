#!/usr/bin/env bun
/**
 * Packages dist/chrome into a versioned .zip for Chrome Web Store upload.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicWebExtensionArchive } from "./package-webextension.mjs";
import {
  buildBrowserBridgeReleaseMetadata,
  resolveBrowserBridgeReleaseVersion,
  versionedArtifactName,
} from "./release-version.mjs";
import { run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const distDir = path.join(extensionRoot, "dist");
const chromeDistDir = path.join(distDir, "chrome");
const artifactsDir = path.join(distDir, "artifacts");
const artifactPath = path.join(artifactsDir, "browser-bridge-chrome.zip");
const release = resolveBrowserBridgeReleaseVersion();
const metadata = buildBrowserBridgeReleaseMetadata(release);
const versionedArtifactPath = path.join(
  artifactsDir,
  versionedArtifactName("browser-bridge-chrome", "zip", release),
);

await run("bun", [path.join(scriptDir, "build.mjs"), "chrome"], {
  cwd: extensionRoot,
});

await fs.mkdir(artifactsDir, { recursive: true });
await fs.access(path.join(chromeDistDir, "manifest.json"));
const result = await createDeterministicWebExtensionArchive({
  sourceDir: chromeDistDir,
  outputPath: artifactPath,
});
await fs.copyFile(artifactPath, versionedArtifactPath);

console.log(
  `Packaged Chrome extension ${metadata.chromeVersionName} (${result.files.length} files, sha256 ${result.sha256}) at ${artifactPath} and ${versionedArtifactPath}`,
);
