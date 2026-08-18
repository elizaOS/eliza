#!/usr/bin/env node
/**
 * Verifies that Chrome and Firefox store archives are deterministic, place the
 * manifest at the archive root, and publish matching SHA-256 sidecars.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { run } from "./script-utils.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");

async function sha256(filePath) {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function verifyBrowserArchive(browser) {
  const packageScript = path.join(scriptDir, `package-${browser}.mjs`);
  const archivePath = path.join(artifactsDir, `browser-bridge-${browser}.zip`);
  await run("bun", [packageScript], { cwd: extensionRoot });
  const firstDigest = await sha256(archivePath);
  await run("bun", [packageScript], { cwd: extensionRoot });
  const secondDigest = await sha256(archivePath);
  if (firstDigest !== secondDigest) {
    throw new Error(`${browser} package is not deterministic`);
  }

  const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath]);
  const entries = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.includes("manifest.json")) {
    throw new Error(`${browser} package does not contain root manifest.json`);
  }
  if (entries.includes(`${browser}/manifest.json`)) {
    throw new Error(`${browser} package incorrectly nests its extension root`);
  }

  const sidecar = await fs.readFile(`${archivePath}.sha256`, "utf8");
  if (!sidecar.startsWith(`${secondDigest}  `)) {
    throw new Error(`${browser} SHA-256 sidecar does not match its archive`);
  }
  return secondDigest;
}

const chromeDigest = await verifyBrowserArchive("chrome");
const firefoxDigest = await verifyBrowserArchive("firefox");
console.log(
  `Extension package contract passed (chrome=${chromeDigest}, firefox=${firefoxDigest})`,
);
