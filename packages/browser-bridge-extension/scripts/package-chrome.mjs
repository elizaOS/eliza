#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBrowserBridgeReleaseMetadata,
  resolveBrowserBridgeReleaseVersion,
  versionedArtifactName,
} from "./release-version.mjs";

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
