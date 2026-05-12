#!/usr/bin/env node
/**
 * validate-ota-metadata.mjs — Static checks for AOSP OTA release metadata.
 *
 * This intentionally does not build, sign, or inspect OTA payload internals.
 * It catches release-index mistakes before metadata is published beside
 * signed OTA artifacts on GitHub Releases or a static mirror.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadBrandFromArgv } from "./brand-config.mjs";

const USAGE =
  "Usage: node scripts/distro-android/validate-ota-metadata.mjs [--brand-config <PATH>] [--allow-file-urls] [--json] <METADATA_JSON>";

const CHANNELS = new Set(["stable", "beta", "nightly", "dev"]);
const PAYLOAD_TYPES = new Set(["full", "incremental"]);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseArgs(argv) {
  const { brand, remaining } = loadBrandFromArgv(argv);
  const options = {
    allowFileUrls: false,
    json: false,
    metadataPath: null,
  };
  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i];
    if (arg === "--allow-file-urls") {
      options.allowFileUrls = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (!arg.startsWith("--") && !options.metadataPath) {
      options.metadataPath = path.resolve(arg);
    } else {
      throw new Error(USAGE);
    }
  }
  if (!options.metadataPath) {
    throw new Error(USAGE);
  }
  return { brand, options };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(errors, value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
    return "";
  }
  return value;
}

function requireSha256(errors, value, field) {
  const text = requireString(errors, value, field);
  if (text && !SHA256_RE.test(text)) {
    errors.push(`${field} must be a 64-character sha256 hex digest`);
  }
}

function requireInteger(errors, value, field, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${field} must be an integer >= ${min}`);
  }
}

function validateUrl(errors, value, field, { allowFileUrls }) {
  const raw = requireString(errors, value, field);
  if (!raw) return;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push(`${field} must be a valid URL`);
    return;
  }
  if (parsed.protocol === "https:") return;
  if (allowFileUrls && parsed.protocol === "file:") return;
  errors.push(`${field} must use https${allowFileUrls ? " or file" : ""}`);
}

export function validateOtaMetadata(metadata, brand, options = {}) {
  const errors = [];
  const warnings = [];
  const allowFileUrls = options.allowFileUrls === true;

  if (!isObject(metadata)) {
    return {
      ok: false,
      errors: ["metadata root must be a JSON object"],
      warnings,
    };
  }

  if (metadata.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (metadata.brand !== brand.brand) {
    errors.push(`brand must match brand config (${brand.brand})`);
  }
  if (metadata.distroName !== brand.distroName) {
    errors.push(`distroName must match brand config (${brand.distroName})`);
  }
  if (metadata.packageName !== brand.packageName) {
    errors.push(`packageName must match brand config (${brand.packageName})`);
  }
  if (!CHANNELS.has(metadata.channel)) {
    errors.push(`channel must be one of ${Array.from(CHANNELS).join(", ")}`);
  }

  requireString(errors, metadata.releaseVersion, "releaseVersion");
  requireString(errors, metadata.buildId, "buildId");
  const buildFingerprint = requireString(
    errors,
    metadata.buildFingerprint,
    "buildFingerprint",
  );
  requireString(errors, metadata.androidVersion, "androidVersion");
  const securityPatchLevel = requireString(
    errors,
    metadata.securityPatchLevel,
    "securityPatchLevel",
  );
  if (securityPatchLevel && !DATE_RE.test(securityPatchLevel)) {
    errors.push("securityPatchLevel must use YYYY-MM-DD");
  }
  validateUrl(errors, metadata.releaseNotesUrl, "releaseNotesUrl", {
    allowFileUrls,
  });

  if (!Array.isArray(metadata.payloads) || metadata.payloads.length === 0) {
    errors.push("payloads must be a non-empty array");
  } else {
    let hasFull = false;
    const seen = new Set();
    for (const [index, payload] of metadata.payloads.entries()) {
      const prefix = `payloads[${index}]`;
      if (!isObject(payload)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (!PAYLOAD_TYPES.has(payload.type)) {
        errors.push(`${prefix}.type must be full or incremental`);
      }
      if (payload.type === "full") hasFull = true;
      if (payload.type === "full" && payload.sourceBuildFingerprint) {
        errors.push(
          `${prefix}.sourceBuildFingerprint must be omitted for full OTAs`,
        );
      }
      if (payload.type === "incremental") {
        requireString(
          errors,
          payload.sourceBuildFingerprint,
          `${prefix}.sourceBuildFingerprint`,
        );
      }
      const target = requireString(
        errors,
        payload.targetBuildFingerprint,
        `${prefix}.targetBuildFingerprint`,
      );
      if (target && buildFingerprint && target !== buildFingerprint) {
        errors.push(
          `${prefix}.targetBuildFingerprint must match buildFingerprint`,
        );
      }
      const fileName = requireString(
        errors,
        payload.fileName,
        `${prefix}.fileName`,
      );
      if (fileName && (fileName.includes("/") || fileName.includes("\\"))) {
        errors.push(`${prefix}.fileName must be a basename, not a path`);
      }
      if (fileName && seen.has(fileName)) {
        errors.push(`${prefix}.fileName duplicates another payload`);
      }
      if (fileName) seen.add(fileName);
      validateUrl(errors, payload.url, `${prefix}.url`, { allowFileUrls });
      requireSha256(errors, payload.sha256, `${prefix}.sha256`);
      requireInteger(errors, payload.sizeBytes, `${prefix}.sizeBytes`, {
        min: 1,
      });
      requireInteger(errors, payload.rollbackIndex, `${prefix}.rollbackIndex`);
      requireInteger(
        errors,
        payload.rollbackIndexLocation,
        `${prefix}.rollbackIndexLocation`,
      );
      if (payload.payloadPropertiesUrl) {
        validateUrl(
          errors,
          payload.payloadPropertiesUrl,
          `${prefix}.payloadPropertiesUrl`,
          { allowFileUrls },
        );
      } else {
        warnings.push(
          `${prefix}.payloadPropertiesUrl missing; update_engine clients may need it beside the payload`,
        );
      }
      if (payload.metadataSha256) {
        requireSha256(
          errors,
          payload.metadataSha256,
          `${prefix}.metadataSha256`,
        );
      }
    }
    if (!hasFull) {
      errors.push("payloads must include at least one full OTA");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function readMetadata(metadataPath) {
  let raw;
  try {
    raw = fs.readFileSync(metadataPath, "utf8");
  } catch (err) {
    throw new Error(`Could not read metadata ${metadataPath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Metadata ${metadataPath} is not valid JSON: ${err.message}`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { brand, options } = parseArgs(argv);
  const metadata = readMetadata(options.metadataPath);
  const result = validateOtaMetadata(metadata, brand, options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    for (const warning of result.warnings) {
      console.warn(`[distro-android:ota-metadata] warning: ${warning}`);
    }
    console.log(
      `[distro-android:ota-metadata] ${brand.distroName} OTA metadata checks passed.`,
    );
  } else {
    console.error(
      `[distro-android:ota-metadata] OTA metadata failed:\n - ${result.errors.join(
        "\n - ",
      )}`,
    );
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
