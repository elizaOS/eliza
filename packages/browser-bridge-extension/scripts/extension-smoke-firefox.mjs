#!/usr/bin/env node
/**
 * Validates the exact Firefox build and deterministic XPI-ready package artifacts.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const firefoxDist = path.join(extensionRoot, "dist", "firefox");
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");

await run("bun", [path.join(scriptDir, "package-firefox.mjs")], {
  cwd: extensionRoot,
});

const manifest = JSON.parse(
  await fs.readFile(path.join(firefoxDist, "manifest.json"), "utf8"),
);
if (manifest.manifest_version !== 3) {
  throw new Error("Firefox manifest must use Manifest V3");
}
if (manifest.background?.scripts?.[0] !== "background.js") {
  throw new Error(
    "Firefox manifest must use a persistent WebExtension background script declaration",
  );
}
if (manifest.background?.service_worker) {
  throw new Error(
    "Firefox build must not depend on Chromium service_worker semantics",
  );
}
if (
  manifest.browser_specific_settings?.gecko?.id !== "browser-bridge@elizaos.ai"
) {
  throw new Error("Firefox manifest is missing the stable Gecko extension ID");
}
if (
  manifest.optional_host_permissions?.join(",") !== "https://*/*,http://*/*"
) {
  throw new Error("Firefox optional host permissions drifted");
}
if (manifest.content_security_policy?.extension_pages.includes("unsafe-eval")) {
  throw new Error("Firefox extension CSP must not permit eval");
}

const zipPath = path.join(artifactsDir, "browser-bridge-firefox.zip");
const xpiPath = path.join(artifactsDir, "browser-bridge-firefox.xpi");
const [zipBytes, xpiBytes] = await Promise.all([
  fs.readFile(zipPath),
  fs.readFile(xpiPath),
]);
if (!zipBytes.equals(xpiBytes)) {
  throw new Error("Firefox ZIP and XPI-ready artifacts must be byte-identical");
}
const entries = unzipSync(new Uint8Array(zipBytes));
if (!entries["manifest.json"] || !entries["background.js"]) {
  throw new Error(
    "Firefox archive must contain manifest.json and background.js at its root",
  );
}
if (entries["firefox/manifest.json"]) {
  throw new Error(
    "Firefox archive must not nest the extension under a firefox directory",
  );
}
const firstHash = createHash("sha256").update(zipBytes).digest("hex");
await run("bun", [path.join(scriptDir, "package-firefox.mjs")], {
  cwd: extensionRoot,
});
const secondHash = createHash("sha256")
  .update(await fs.readFile(zipPath))
  .digest("hex");
if (firstHash !== secondHash) {
  throw new Error("Firefox package is not byte-reproducible");
}
console.log(`Firefox extension smoke passed (sha256 ${secondHash})`);
