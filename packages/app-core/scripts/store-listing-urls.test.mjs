/**
 * Contract tests for the support/privacy/repository URLs that ship inside store
 * listing metadata (MSIX Partner Center, iOS fastlane, Inno Setup, Flatpak
 * AppStream, Homebrew).
 *
 * Store reviewers follow these URLs literally, so a dead one blocks a listing
 * rather than degrading it. Two failure modes are pinned here because both have
 * already shipped: references to the retired `elizaos/elizaos-app` GitHub repo
 * (the org/repo no longer resolves), and Eliza Cloud paths that do not match a
 * route registered in `packages/ui/src/cloud/public-pages/register.ts`. The
 * cloud app serves an SPA fallback, so an unregistered path still answers HTTP
 * 200 — only the route registry proves the page exists, which is why this suite
 * reads that file as the source of truth instead of probing the network.
 *
 * Deterministic and offline: every assertion is a pure read of repository files.
 * Runs under node:test (see mas-smoke.test.mjs for the same pattern); excluded
 * from vitest in packages/app-core/vitest.config.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveElizaWorkspaceRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const appCoreRoot = path.join(repoRoot, "packages", "app-core");

const RETIRED_REPO_PATTERN = /github\.com\/elizaos\/elizaos-app/i;
const CANONICAL_REPO = "https://github.com/elizaOS/eliza";
const CLOUD_ORIGIN = "https://cloud.eliza.app";

/** Store metadata files that may carry outbound URLs a reviewer will open. */
const METADATA_FILES = [
  "packaging/msix/store/listing.json",
  "packaging/inno/ElizaOSApp.iss",
  "packaging/flatpak/ai.elizaos.App.metainfo.xml",
  "packaging/snap/snapcraft.yaml",
  "packaging/homebrew/elizaos-app.rb",
  "packaging/homebrew/elizaos-app.cask.rb",
  "packaging/homebrew/README.md",
  "platforms/ios/fastlane/metadata/en-US/privacy_url.txt",
  "platforms/ios/fastlane/metadata/en-US/support_url.txt",
  "platforms/ios/fastlane/metadata/en-US/marketing_url.txt",
];

function readMetadata(relativePath) {
  return readFileSync(path.join(appCoreRoot, relativePath), "utf8");
}

/**
 * Paths registered as cloud routes. `registerCloudRoute({ path: "x" })` is the
 * only way a public cloud page becomes reachable, so the literal set here is
 * the full inventory of valid `https://cloud.eliza.app/<path>` destinations.
 */
function registeredCloudRoutePaths() {
  const registerSource = readFileSync(
    path.join(
      repoRoot,
      "packages",
      "ui",
      "src",
      "cloud",
      "public-pages",
      "register.ts",
    ),
    "utf8",
  );
  const paths = new Set();
  for (const match of registerSource.matchAll(/^\s*path:\s*"([^"]*)",/gm)) {
    paths.add(match[1]);
  }
  assert.ok(
    paths.size > 0,
    "expected registerCloudRoute() path literals in packages/ui/src/cloud/public-pages/register.ts",
  );
  return paths;
}

test("no store metadata references the retired elizaos/elizaos-app repository", () => {
  for (const relativePath of METADATA_FILES) {
    const contents = readMetadata(relativePath);
    assert.equal(
      RETIRED_REPO_PATTERN.test(contents),
      false,
      `${relativePath} references the retired elizaos/elizaos-app repository; use ${CANONICAL_REPO}`,
    );
  }
});

test("every cloud.eliza.app destination matches a registered cloud route", () => {
  const registered = registeredCloudRoutePaths();
  let checked = 0;

  for (const relativePath of METADATA_FILES) {
    const contents = readMetadata(relativePath);
    for (const match of contents.matchAll(
      /https:\/\/cloud\.eliza\.app(\/[A-Za-z0-9\-_/]*)?/g,
    )) {
      const routePath = (match[1] ?? "").replace(/^\/+|\/+$/g, "");
      if (routePath === "") continue; // the bare origin is the marketing site
      checked += 1;
      assert.ok(
        registered.has(routePath),
        `${relativePath} points at ${CLOUD_ORIGIN}/${routePath}, which is not a registered cloud route (the SPA fallback answers 200 for unrouted paths, so this would ship a blank page to store reviewers)`,
      );
    }
  }

  assert.ok(
    checked > 0,
    "expected at least one cloud.eliza.app deep link in store metadata",
  );
});

test("privacy and support destinations are the canonical live endpoints", () => {
  const iosPrivacy = readMetadata(
    "platforms/ios/fastlane/metadata/en-US/privacy_url.txt",
  ).trim();
  const iosSupport = readMetadata(
    "platforms/ios/fastlane/metadata/en-US/support_url.txt",
  ).trim();
  assert.equal(iosPrivacy, `${CLOUD_ORIGIN}/privacy-policy`);
  assert.equal(iosSupport, `${CANONICAL_REPO}/issues`);

  const listing = JSON.parse(readMetadata("packaging/msix/store/listing.json"));
  assert.equal(listing.listing.privacyUrl, `${CLOUD_ORIGIN}/privacy-policy`);
  assert.equal(listing.listing.supportUrl, `${CANONICAL_REPO}/issues`);

  const inno = readMetadata("packaging/inno/ElizaOSApp.iss");
  assert.match(
    inno,
    /^AppSupportURL=https:\/\/github\.com\/elizaOS\/eliza\/issues$/m,
  );
  assert.match(
    inno,
    /^AppUpdatesURL=https:\/\/github\.com\/elizaOS\/eliza\/releases$/m,
  );

  const metainfo = readMetadata(
    "packaging/flatpak/ai.elizaos.App.metainfo.xml",
  );
  assert.match(
    metainfo,
    /<url type="bugtracker">https:\/\/github\.com\/elizaOS\/eliza\/issues<\/url>/,
  );
  assert.match(
    metainfo,
    /<url type="vcs-browser">https:\/\/github\.com\/elizaOS\/eliza<\/url>/,
  );
});
