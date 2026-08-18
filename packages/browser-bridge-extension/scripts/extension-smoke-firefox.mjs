#!/usr/bin/env node
/**
 * Validates the Firefox build tree and its least-privilege manifest contract.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const outputDir = path.join(extensionRoot, "dist", "firefox");

await run("bun", [path.join(scriptDir, "build.mjs"), "firefox"], {
  cwd: extensionRoot,
});
const manifest = JSON.parse(
  await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"),
);
assert.deepEqual(manifest.background, { scripts: ["background.js"] });
assert.equal(
  manifest.browser_specific_settings.gecko.id,
  "browser-bridge@elizaos.ai",
);
assert.deepEqual(manifest.optional_host_permissions, [
  "https://*/*",
  "http://*/*",
]);
assert.ok(!manifest.host_permissions.includes("<all_urls>"));
assert.equal(
  manifest.content_security_policy.extension_pages,
  "script-src 'self'; object-src 'self'",
);
assert.ok(
  manifest.content_scripts.every(
    (entry) => !entry.js?.includes("wallet-shim.js"),
  ),
  "wallet shim must not be statically injected into every allowlisted page",
);
for (const asset of [
  "background.js",
  "content.js",
  "popup.js",
  "blocked.js",
  "wallet-shim.js",
]) {
  await fs.access(path.join(outputDir, asset));
}
console.log("Firefox extension build contract passed");
