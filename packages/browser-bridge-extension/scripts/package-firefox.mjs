#!/usr/bin/env bun
/**
 * Builds deterministic Firefox ZIP/XPI submission archives. The XPI is not a
 * permanent-install artifact until Mozilla signs it through AMO.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicWebExtensionArchive } from "./package-webextension.mjs";
import {
  resolveBrowserBridgeReleaseVersion,
  versionedArtifactName,
} from "./release-version.mjs";
import { run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const firefoxDistDir = path.join(extensionRoot, "dist", "firefox");
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");
const release = resolveBrowserBridgeReleaseVersion();
const zipPath = path.join(artifactsDir, "browser-bridge-firefox.zip");
const xpiPath = path.join(artifactsDir, "browser-bridge-firefox.xpi");
const versionedZipPath = path.join(
  artifactsDir,
  versionedArtifactName("browser-bridge-firefox", "zip", release),
);
const versionedXpiPath = path.join(
  artifactsDir,
  versionedArtifactName("browser-bridge-firefox", "xpi", release),
);

await run("bun", [path.join(scriptDir, "build.mjs"), "firefox"], {
  cwd: extensionRoot,
});
const result = await createDeterministicWebExtensionArchive({
  sourceDir: firefoxDistDir,
  outputPath: zipPath,
});
await Promise.all([
  fs.copyFile(zipPath, xpiPath),
  fs.copyFile(zipPath, versionedZipPath),
  fs.copyFile(zipPath, versionedXpiPath),
]);
console.log(
  `Packaged Firefox extension (${result.files.length} files, sha256 ${result.sha256}) at ${zipPath}`,
);
