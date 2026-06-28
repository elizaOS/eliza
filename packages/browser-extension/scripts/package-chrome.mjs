#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
await fs.rm(artifactPath, { force: true });
await fs.rm(versionedArtifactPath, { force: true });
await fs.access(path.join(chromeDistDir, "manifest.json"));

await run("zip", ["-qr", artifactPath, "chrome"], {
  cwd: distDir,
});
await fs.copyFile(artifactPath, versionedArtifactPath);

console.log(
  `Packaged Chrome extension ${metadata.chromeVersionName} at ${artifactPath} and ${versionedArtifactPath}`,
);
