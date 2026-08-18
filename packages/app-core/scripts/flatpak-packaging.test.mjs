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
  resolve(flatpakDirectory, "ai.elizaos.App.yml"),
  "utf8",
);
const directManifest = readFileSync(
  resolve(flatpakDirectory, "ai.elizaos.App.direct.yml"),
  "utf8",
);
const nodeSourcesText = readFileSync(
  resolve(flatpakDirectory, "node-sources.json"),
  "utf8",
);
const nodeSources = JSON.parse(nodeSourcesText);
const flatpakPackage = JSON.parse(
  readFileSync(resolve(flatpakDirectory, "flatpak-package.json"), "utf8"),
);
const flatpakLock = JSON.parse(
  readFileSync(resolve(flatpakDirectory, "flatpak-package-lock.json"), "utf8"),
);
const generator = readFileSync(
  resolve(flatpakDirectory, "generate-sources.sh"),
  "utf8",
);
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/flatpak-packaging.yml"),
  "utf8",
);
const metadata = readFileSync(
  resolve(flatpakDirectory, "ai.elizaos.App.metainfo.xml"),
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
}

test("Flatpak variants pin the repository Node release", () => {
  assertPinnedRuntime(storeManifest);
  assertPinnedRuntime(directManifest);
});

test("Flathub build consumes the committed npm closure without network", () => {
  const buildOptions = storeManifest.slice(
    storeManifest.indexOf("build-options:"),
    storeManifest.indexOf("\nmodules:"),
  );
  assert.doesNotMatch(buildOptions, /--share=network/);
  assert.match(storeManifest, /npm ci --offline/);
  assert.match(storeManifest, /^\s+- node-sources\.json$/m);
  assert.match(storeManifest, /path: flatpak-package-lock\.json/);
});

test("vendored npm closure and generator target the exact CLI release", () => {
  assert.match(
    nodeSourcesText,
    new RegExp(`elizaos-${cliPackage.version.replaceAll(".", "\\.")}\\.tgz`),
  );
  assert.match(generator, /packages\/elizaos\/package\.json/);
  assert.match(generator, /--save-exact/);
  assert.doesNotMatch(generator, /elizaos@latest/);
  assert.equal(flatpakPackage.dependencies.elizaos, cliPackage.version);
  assert.equal(
    flatpakLock.packages["node_modules/elizaos"].version,
    cliPackage.version,
  );
  assert.equal(
    flatpakLock.packages[""].dependencies.elizaos,
    cliPackage.version,
  );

  const cachedArchives = new Map(
    nodeSources
      .filter((source) => source.type === "file" && source.url)
      .map((source) => [source.url, source.sha512]),
  );
  const lockedArchives = Object.values(flatpakLock.packages).filter(
    (entry) => entry.resolved,
  );
  assert.deepEqual(
    [...cachedArchives.keys()].sort(),
    lockedArchives.map((entry) => entry.resolved).sort(),
  );
  for (const entry of lockedArchives) {
    assert.match(entry.integrity, /^sha512-/);
    const expectedHex = Buffer.from(
      entry.integrity.slice("sha512-".length),
      "base64",
    ).toString("hex");
    assert.equal(cachedArchives.get(entry.resolved), expectedHex);
  }
});

test("Linux acceptance lints and launches the installed Flatpak", () => {
  assert.match(workflow, /flatpak-builder-lint[\s\S]*manifest/);
  assert.match(workflow, /flatpak-builder-lint[\s\S]*appstream/);
  assert.match(workflow, /flatpak-builder-lint[\s\S]*repo repo/);
  assert.match(workflow, /flatpak run ai\.elizaos\.App --help/);
  assert.match(workflow, /ai\.elizaos\.App start/);
  assert.match(workflow, /\/api\/health/);
  assert.match(workflow, /"ready":true/);
  assert.match(workflow, /--install --repo=repo/);
  assert.match(
    workflow,
    /--mirror-screenshots-url=https:\/\/dl\.flathub\.org\/media/,
  );
  assert.doesNotMatch(workflow, /--compose-url-policy/);
});

test("AppStream release and repository URLs match the packaged CLI", () => {
  assert.match(
    metadata,
    new RegExp(`<release version="${cliPackage.version}"`),
  );
  assert.match(metadata, /https:\/\/github\.com\/elizaOS\/eliza\/issues/);
  assert.match(metadata, /https:\/\/github\.com\/elizaOS\/eliza<\/url>/);
  assert.doesNotMatch(metadata, /github\.com\/elizaos\/elizaos-app/);
});
