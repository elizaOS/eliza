/**
 * Verifies that Flatpak manifests are bound to the repository runtime and
 * published CLI version, and that the Flathub variant remains build-offline.
 * This deterministic contract runs without Flatpak; Linux CI separately
 * builds and installs the real store manifest.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../..");
const flatpakDirectory = resolve(scriptDirectory, "../packaging/flatpak");

const rootPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const cliPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/elizaos/package.json"), "utf8"),
);
const storeManifest = readFileSync(
  resolve(flatpakDirectory, "ai.elizaos.App.store.yml"),
  "utf8",
);
const directManifest = readFileSync(
  resolve(flatpakDirectory, "ai.elizaos.App.yml"),
  "utf8",
);
const nodeSources = readFileSync(
  resolve(flatpakDirectory, "node-sources.json"),
  "utf8",
);
const generator = readFileSync(
  resolve(flatpakDirectory, "generate-sources.sh"),
  "utf8",
);

function assertPinnedRuntime(manifest) {
  const nodeVersion = rootPackage.engines.node;
  assert.match(
    manifest,
    new RegExp(
      `node-v${nodeVersion.replaceAll(".", "\\.")}-linux-x64\\.tar\\.xz`,
    ),
  );
  assert.match(
    manifest,
    new RegExp(
      `node-v${nodeVersion.replaceAll(".", "\\.")}-linux-arm64\\.tar\\.xz`,
    ),
  );
  assert.match(
    manifest,
    new RegExp(`elizaos@${cliPackage.version.replaceAll(".", "\\.")}`),
  );
}

test("Flatpak variants pin the repository Node and CLI releases", () => {
  assertPinnedRuntime(storeManifest);
  assertPinnedRuntime(directManifest);
});

test("Flathub build consumes the committed npm closure without network", () => {
  const buildOptions = storeManifest.slice(
    storeManifest.indexOf("build-options:"),
    storeManifest.indexOf("\nmodules:"),
  );
  assert.doesNotMatch(buildOptions, /--share=network/);
  assert.match(storeManifest, /npm install -g --offline/);
  assert.match(storeManifest, /^\s+- node-sources\.json$/m);
});

test("vendored npm closure and generator target the exact CLI release", () => {
  assert.match(
    nodeSources,
    new RegExp(`elizaos-${cliPackage.version.replaceAll(".", "\\.")}\\.tgz`),
  );
  assert.match(generator, /packages\/elizaos\/package\.json/);
  assert.match(generator, /--save-exact/);
  assert.doesNotMatch(generator, /elizaos@latest/);
});
