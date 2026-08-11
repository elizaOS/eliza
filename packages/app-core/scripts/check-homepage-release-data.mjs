#!/usr/bin/env node
/**
 * CI guard for the generated homepage release payload: parses
 * packages/homepage/src/generated/release-data.ts and fails when required
 * download-artifact ids (macOS/Windows/Linux/Android) are missing or the
 * payload is malformed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unavailableReleaseFinding } from "./lib/homepage-release-validation.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const RELEASE_DATA_PATH = path.resolve(
  REPO_ROOT,
  "packages/homepage/src/generated/release-data.ts",
);

const REQUIRED_IDS = new Set([
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "linux-x64",
  "android-apk",
]);

const OPTIONAL_IDS = new Set(["linux-deb", "linux-rpm"]);

function parseGeneratedModule(source) {
  const marker = "export const releaseData: ReleaseDataPayload = ";
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error("generated module does not export releaseData");
  }

  const jsonStart = start + marker.length;
  const jsonEnd = source.lastIndexOf(";\n");
  if (jsonEnd <= jsonStart) {
    throw new Error("generated module does not contain a complete payload");
  }

  return JSON.parse(source.slice(jsonStart, jsonEnd));
}

function fail(message, details = []) {
  console.error(`homepage release data check failed: ${message}`);
  for (const detail of details) {
    console.error(`- ${detail}`);
  }
  process.exit(1);
}

const source = await readFile(RELEASE_DATA_PATH, "utf8");
const payload = parseGeneratedModule(source);
const release = payload.release;

if (!release || release.tagName === "unavailable") {
  // A missing `release` property is a malformed payload, not a valid
  // unavailable state. The generator always writes a release object (even
  // the null fallback). Only an explicitly structured unavailable release
  // is acceptable here.
  if (!release) {
    fail("payload is malformed: release property is missing");
  }
  const finding = unavailableReleaseFinding(release);
  if (finding) {
    fail(finding.message, finding.details);
  }
  // An explicit "unavailable" state is valid when no public product release
  // with installer assets exists. This prevents internal/evidence tags from
  // being displayed as the Latest release.
  console.warn(
    "homepage release data: no usable product release with installer assets; rendering unavailable state",
  );
} else {
  const downloads = Array.isArray(release.downloads) ? release.downloads : [];
  const missing = [...REQUIRED_IDS].filter(
    (id) => !downloads.some((download) => download.id === id),
  );

  if (missing.length > 0) {
    fail("required installer artifacts are missing", [
      `release: ${release.tagName}`,
      `missing ids: ${missing.join(", ")}`,
      `found ids: ${downloads.map((download) => download.id).join(", ") || "none"}`,
    ]);
  }

  const optionalMissing = [...OPTIONAL_IDS].filter(
    (id) => !downloads.some((download) => download.id === id),
  );

  const crossReleaseDownloads = downloads.filter(
    (download) => download.releaseTagName !== release.tagName,
  );

  if (crossReleaseDownloads.length > 0) {
    fail(
      "download assets must come from the same release as the homepage banner",
      crossReleaseDownloads.map(
        (download) =>
          `${download.id}: ${download.releaseTagName} (${download.fileName})`,
      ),
    );
  }

  console.log(
    `homepage release data check passed: ${release.tagName} (${downloads.length} downloads)`,
  );
  if (optionalMissing.length > 0) {
    console.warn(
      `homepage release data optional package formats not present yet: ${optionalMissing.join(", ")}`,
    );
  }
}

// Store-target validation is independent of release availability.
const storeTargets = Array.isArray(payload.storeTargets)
  ? payload.storeTargets
  : [];
const placeholderStores = storeTargets.filter(
  (store) =>
    store.url &&
    (store.status !== "available" || !/^https:\/\/.+/i.test(store.url)),
);

if (placeholderStores.length > 0) {
  fail(
    "store targets must not contain placeholder or unavailable URLs",
    placeholderStores.map((store) => `${store.platform}: ${store.url}`),
  );
}
