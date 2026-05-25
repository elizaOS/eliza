#!/usr/bin/env node
/**
 * Patch legacy packages that still require Node's deprecated `punycode` core
 * module. The trailing slash forces resolution to the userland package.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const targetFiles = [
  "node_modules/.bun/whatwg-url@7.1.0/node_modules/whatwg-url/lib/url-state-machine.js",
  "node_modules/.bun/tr46@1.0.1/node_modules/tr46/index.js",
  "dist/node_modules/node-fetch/node_modules/whatwg-url/lib/url-state-machine.js",
  "dist/node_modules/node-fetch/node_modules/whatwg-url/node_modules/tr46/index.js",
  "packages/app-core/platforms/electrobun/build/dev-macos-arm64/Eliza-dev.app/Contents/Resources/app/eliza-dist/node_modules/node-fetch/node_modules/whatwg-url/lib/url-state-machine.js",
  "packages/app-core/platforms/electrobun/build/dev-macos-arm64/Eliza-dev.app/Contents/Resources/app/eliza-dist/node_modules/node-fetch/node_modules/whatwg-url/node_modules/tr46/index.js",
];

let patched = 0;

for (const relativePath of targetFiles) {
  const filePath = join(repoRoot, relativePath);
  if (!existsSync(filePath)) continue;

  const before = readFileSync(filePath, "utf8");
  const after = before.replaceAll(
    /require\((["'])punycode\1\)/g,
    "require($1punycode/$1)",
  );

  if (after === before) continue;
  writeFileSync(filePath, after);
  patched++;
  console.log(`[patch-punycode-deprecation] Patched ${relativePath}`);
}

if (patched > 0) {
  console.log(
    `[patch-punycode-deprecation] Patched ${patched} punycode import(s).`,
  );
}
