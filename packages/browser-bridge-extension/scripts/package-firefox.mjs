#!/usr/bin/env node

/**
 * Builds and packages the Firefox WebExtension as an unsigned XPI-ready ZIP.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBrowserBridgeReleaseVersion,
  versionedArtifactName,
} from "./release-version.mjs";
import { run } from "./script-utils.mjs";

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
const reproducibleTimestamp = new Date("2020-01-01T00:00:00.000Z");

async function normalizeTreeTimestamps(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await normalizeTreeTimestamps(entryPath);
    await fs.utimes(entryPath, reproducibleTimestamp, reproducibleTimestamp);
  }
  await fs.utimes(directory, reproducibleTimestamp, reproducibleTimestamp);
}

await run("bun", [path.join(scriptDir, "build.mjs"), "firefox"], {
  cwd: extensionRoot,
});
await fs.mkdir(artifactsDir, { recursive: true });
await fs.rm(artifactPath, { force: true });
await fs.rm(versionedArtifactPath, { force: true });
await fs.access(path.join(firefoxDistDir, "manifest.json"));
await normalizeTreeTimestamps(firefoxDistDir);
await run("zip", ["-Xqr", artifactPath, "firefox"], { cwd: distDir });
await fs.copyFile(artifactPath, versionedArtifactPath);
const digest = createHash("sha256")
  .update(await fs.readFile(artifactPath))
  .digest("hex");
await fs.writeFile(
  `${artifactPath}.sha256`,
  `${digest}  ${path.basename(artifactPath)}\n`,
);
await fs.writeFile(
  `${versionedArtifactPath}.sha256`,
  `${digest}  ${path.basename(versionedArtifactPath)}\n`,
);

console.log(`Packaged Firefox extension ${release.raw} at ${artifactPath}`);
