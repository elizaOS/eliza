#!/usr/bin/env node

/**
 * Builds and packages the Firefox WebExtension as an unsigned XPI-ready ZIP.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBrowserBridgeReleaseVersion,
  versionedArtifactName,
} from "./release-version.mjs";
import {
  normalizeTreeTimestamps,
  run,
  writeSha256Sidecar,
} from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const distDir = path.join(extensionRoot, "dist");
const firefoxDistDir = path.join(distDir, "firefox");
const artifactsDir = path.join(distDir, "artifacts");
const artifactPath = path.join(artifactsDir, "browser-bridge-firefox.zip");
const release = resolveBrowserBridgeReleaseVersion();
const versionedArtifactPath = path.join(
  artifactsDir,
  versionedArtifactName("browser-bridge-firefox", "zip", release),
);
await run("bun", [path.join(scriptDir, "build.mjs"), "firefox"], {
  cwd: extensionRoot,
});
await fs.mkdir(artifactsDir, { recursive: true });
await fs.rm(artifactPath, { force: true });
await fs.rm(versionedArtifactPath, { force: true });
await fs.access(path.join(firefoxDistDir, "manifest.json"));
await normalizeTreeTimestamps(firefoxDistDir);
await run("zip", ["-Xqr", artifactPath, "."], { cwd: firefoxDistDir });
await fs.copyFile(artifactPath, versionedArtifactPath);
await writeSha256Sidecar(artifactPath);
await writeSha256Sidecar(versionedArtifactPath);

console.log(`Packaged Firefox extension ${release.raw} at ${artifactPath}`);
