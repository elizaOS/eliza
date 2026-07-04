#!/usr/bin/env node
/**
 * Validates an iOS device-evidence manifest against the required check-id
 * contract (ReplayKit foreground start, broadcast-extension handshake, Vision
 * OCR, app-intent invocations, Foundation-model generation, memory-pressure
 * probe). Fails when a required check is missing or carries a status outside
 * the allowed set.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_CHECK_IDS = new Set([
  "probe",
  "replayKitForegroundStart",
  "broadcastExtensionHandshake",
  "visionOcr",
  "appIntentList",
  "appIntentInvokeSafari",
  "appIntentInvokeMessages",
  "accessibilitySnapshot",
  "foundationModelGenerate",
  "memoryPressureProbe",
]);

const COMPLETE_STATUSES = new Set(["passed", "blocked_by_platform"]);
const ALLOWED_STATUSES = new Set([
  "requires_device_evidence",
  "passed",
  "failed",
  "blocked_by_platform",
]);

function usage() {
  return [
    "Usage: node scripts/validate-ios-device-evidence.mjs [--require-complete] [manifest]",
    "",
    "Validates docs/ios-device-validation.json. With --require-complete, every",
    "check must have passed or be explicitly blocked by platform behavior, and",
    "top-level device/build/validator evidence must be present.",
  ].join("\n");
}

function fail(message) {
  console.error(`[ios-device-evidence] ${message}`);
  process.exitCode = 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const args = process.argv.slice(2);
let requireComplete = false;
let manifestArg;

for (const arg of args) {
  if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (arg === "--require-complete") {
    requireComplete = true;
    continue;
  }
  if (manifestArg) {
    fail(`unexpected argument: ${arg}`);
  } else {
    manifestArg = arg;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath =
  manifestArg ?? path.resolve(here, "../docs/ios-device-validation.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!isRecord(manifest)) fail("manifest must be an object");
if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
if (manifest.platform !== "ios") fail('platform must be "ios"');
if (!ALLOWED_STATUSES.has(manifest.status)) {
  fail(`invalid top-level status: ${manifest.status}`);
}
if (!isRecord(manifest.target)) fail("target must be an object");
for (const key of ["minimumIos", "primaryIos", "minimumDeviceClass"]) {
  if (!nonEmptyString(manifest.target[key])) {
    fail(`target.${key} must be a non-empty string`);
  }
}
if (!isRecord(manifest.evidence)) fail("evidence must be an object");
if (!Array.isArray(manifest.evidence.artifacts)) {
  fail("evidence.artifacts must be an array");
}
if (!Array.isArray(manifest.checks)) fail("checks must be an array");

const seen = new Set();
for (const check of manifest.checks) {
  if (!isRecord(check)) {
    fail("each check must be an object");
    continue;
  }
  if (!REQUIRED_CHECK_IDS.has(check.id)) {
    fail(`unexpected check id: ${check.id}`);
  }
  if (seen.has(check.id)) {
    fail(`duplicate check id: ${check.id}`);
  }
  seen.add(check.id);
  if (!nonEmptyString(check.method)) {
    fail(`check ${check.id} missing method`);
  }
  if (!ALLOWED_STATUSES.has(check.status)) {
    fail(`check ${check.id} has invalid status: ${check.status}`);
  }
  if (
    !Array.isArray(check.requiredEvidence) ||
    check.requiredEvidence.length === 0 ||
    !check.requiredEvidence.every(nonEmptyString)
  ) {
    fail(`check ${check.id} must list requiredEvidence strings`);
  }
}

for (const id of REQUIRED_CHECK_IDS) {
  if (!seen.has(id)) fail(`missing check id: ${id}`);
}

if (requireComplete) {
  for (const key of [
    "deviceModel",
    "iosVersion",
    "buildId",
    "validatedAt",
    "validator",
  ]) {
    if (!nonEmptyString(manifest.evidence[key])) {
      fail(`--require-complete needs evidence.${key}`);
    }
  }
  if (manifest.evidence.artifacts.length === 0) {
    fail("--require-complete needs at least one evidence artifact");
  }
  for (const check of manifest.checks) {
    if (!COMPLETE_STATUSES.has(check.status)) {
      fail(`--require-complete: check ${check.id} is ${check.status}`);
    }
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(
  `[ios-device-evidence] ${manifest.checks.length} checks validated (${manifest.status})`,
);
