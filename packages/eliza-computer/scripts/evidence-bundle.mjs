/**
 * Validates and publishes evidence as one same-filesystem transaction so a
 * failed capture cannot mix partial output with a previously complete bundle.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const ARTIFACT_NAMES = [
  "after-desktop.jpg",
  "after-mobile.jpg",
  "browser-log.json",
  "site-verification.json",
  "walkthrough.mp4",
];
const BUNDLE_NAMES = [...ARTIFACT_NAMES, "manifest.json"].sort();

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function parseJson(path, context) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // error-policy:J2 evidence validation retains the unreadable artifact path.
    throw new TypeError(`${context} must contain valid JSON`, { cause: error });
  }
}

function asObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value;
}

function assertRegularFile(path, context) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new TypeError(`${context} must be a non-empty regular file`);
  }
  return metadata.size;
}

export function validateEvidenceBundle(root, { buildFingerprint, mode }) {
  const entries = readdirSync(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== BUNDLE_NAMES.length ||
    names.some((name, index) => name !== BUNDLE_NAMES[index]) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new TypeError(
      `evidence bundle must contain exactly: ${BUNDLE_NAMES.join(", ")}`,
    );
  }

  const manifest = asObject(
    parseJson(join(root, "manifest.json"), "evidence manifest"),
    "evidence manifest",
  );
  if (
    manifest.schemaVersion !== "1" ||
    manifest.mode !== mode ||
    manifest.buildFingerprint !== buildFingerprint
  ) {
    throw new TypeError(
      "evidence manifest does not match the selected mode and build",
    );
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new TypeError("evidence manifest.artifacts must be an array");
  }
  const artifactNames = manifest.artifacts
    .map((artifact, index) => {
      const value = asObject(artifact, `evidence manifest.artifacts[${index}]`);
      if (
        typeof value.name !== "string" ||
        !ARTIFACT_NAMES.includes(value.name) ||
        typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
      ) {
        throw new TypeError(`evidence manifest.artifacts[${index}] is invalid`);
      }
      const path = join(root, value.name);
      assertRegularFile(path, `evidence artifact ${value.name}`);
      if (sha256(readFileSync(path)) !== value.sha256) {
        throw new TypeError(
          `evidence artifact ${value.name} does not match its digest`,
        );
      }
      return value.name;
    })
    .sort();
  if (
    artifactNames.length !== ARTIFACT_NAMES.length ||
    artifactNames.some((name, index) => name !== ARTIFACT_NAMES[index])
  ) {
    throw new TypeError(
      "evidence manifest must bind every artifact exactly once",
    );
  }

  const validation = asObject(
    manifest.validation,
    "evidence manifest.validation",
  );
  for (const key of [
    "consoleErrors",
    "failedFirstPartyRequests",
    "failedFirstPartyResponses",
    "pageErrors",
  ]) {
    if (validation[key] !== 0) {
      throw new TypeError(`evidence validation ${key} must be zero`);
    }
  }

  const browserLog = asObject(
    parseJson(join(root, "browser-log.json"), "browser log"),
    "browser log",
  );
  const siteVerification = asObject(
    parseJson(join(root, "site-verification.json"), "site verification"),
    "site verification",
  );
  if (
    browserLog.mode !== mode ||
    siteVerification.mode !== mode ||
    browserLog.buildFingerprint !== buildFingerprint ||
    siteVerification.buildFingerprint !== buildFingerprint ||
    browserLog.capturedAt !== manifest.capturedAt ||
    siteVerification.capturedAt !== manifest.capturedAt
  ) {
    throw new TypeError(
      "evidence JSON artifacts do not describe one capture transaction",
    );
  }
  for (const key of ["console", "network", "pageErrors", "requestFailures"]) {
    if (!Array.isArray(browserLog[key])) {
      throw new TypeError(`browser log.${key} must be an array`);
    }
  }
  if (
    browserLog.console.some((entry) => entry?.type === "error") ||
    browserLog.pageErrors.length > 0 ||
    browserLog.requestFailures.length > 0
  ) {
    throw new TypeError("browser log contains a captured failure");
  }

  for (const name of ["after-desktop.jpg", "after-mobile.jpg"]) {
    const contents = readFileSync(join(root, name));
    if (
      contents[0] !== 0xff ||
      contents[1] !== 0xd8 ||
      contents[contents.length - 2] !== 0xff ||
      contents[contents.length - 1] !== 0xd9
    ) {
      throw new TypeError(`${name} is not a complete JPEG`);
    }
  }
  const video = readFileSync(join(root, "walkthrough.mp4"));
  if (video.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new TypeError("walkthrough.mp4 is not an MP4 file");
  }

  return {
    artifactCount: ARTIFACT_NAMES.length,
    capturedAt: manifest.capturedAt,
    mode,
  };
}

export function beginEvidenceTransaction(finalRoot) {
  const parent = dirname(finalRoot);
  mkdirSync(parent, { recursive: true });
  const stagingRoot = mkdtempSync(
    join(parent, `.${basename(finalRoot)}-staging-`),
  );
  let state = "open";

  return {
    stagingRoot,
    abort() {
      if (state !== "open") return;
      rmSync(stagingRoot, { force: true, recursive: true });
      state = "aborted";
    },
    publish() {
      if (state !== "open") {
        throw new TypeError(`evidence transaction is already ${state}`);
      }
      const backupRoot = join(
        parent,
        `.${basename(finalRoot)}-backup-${randomUUID()}`,
      );
      const hadPrevious = existsSync(finalRoot);
      let previousMoved = false;
      try {
        if (hadPrevious) {
          renameSync(finalRoot, backupRoot);
          previousMoved = true;
        }
        renameSync(stagingRoot, finalRoot);
        state = "published";
        if (previousMoved) {
          rmSync(backupRoot, { force: true, recursive: true });
        }
      } catch (error) {
        // error-policy:J2 publication restores the last complete evidence bundle before failing.
        if (previousMoved && !existsSync(finalRoot) && existsSync(backupRoot)) {
          renameSync(backupRoot, finalRoot);
        }
        throw new Error("evidence bundle publication failed", {
          cause: error,
        });
      }
    },
  };
}
