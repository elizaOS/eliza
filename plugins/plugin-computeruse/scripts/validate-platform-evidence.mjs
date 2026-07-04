#!/usr/bin/env node
/**
 * Validates a desktop/mobile platform evidence manifest against its per-platform
 * contract (required target keys and complete-evidence keys), enforcing that
 * every check reports an allowed status and that passed platforms carry the
 * device metadata the contract demands.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPLETE_STATUSES = new Set(["passed", "blocked_by_platform"]);
const ALLOWED_STATUSES = new Set([
  "requires_device_evidence",
  "passed",
  "failed",
  "blocked_by_platform",
]);

const PLATFORM_CONTRACTS = {
  ios: {
    label: "ios-device-evidence",
    defaultManifest: "docs/ios-device-validation.json",
    targetKeys: ["minimumIos", "primaryIos", "minimumDeviceClass"],
    completeEvidenceKeys: [
      "deviceModel",
      "iosVersion",
      "buildId",
      "validatedAt",
      "validator",
    ],
    checkIds: [
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
    ],
  },
  "android-consumer": {
    label: "android-device-evidence",
    defaultManifest: "docs/android-device-validation.json",
    targetKeys: [
      "minimumApi",
      "minimumAndroid",
      "requiredBuildFlavor",
      "distribution",
    ],
    completeEvidenceKeys: [
      "deviceModel",
      "androidVersion",
      "apiLevel",
      "buildId",
      "validatedAt",
      "validator",
    ],
    checkIds: [
      "permissionsSetup",
      "accessibilityTree",
      "gestureDispatch",
      "globalActions",
      "mediaProjectionCapture",
      "usageStatsEnumeration",
      "cameraCapture",
      "memoryPressureDispatch",
      "appActionsShortcuts",
      "lifeOpsScheduledTaskHandoff",
    ],
  },
  "android-aosp": {
    label: "android-aosp-evidence",
    defaultManifest: "docs/android-aosp-validation.json",
    targetKeys: [
      "minimumApi",
      "imageType",
      "requiredBuildFlavor",
      "privilegedPermissions",
    ],
    completeEvidenceKeys: [
      "imageName",
      "androidVersion",
      "apiLevel",
      "buildId",
      "validatedAt",
      "validator",
    ],
    checkIds: [
      "assistantRole",
      "assistVoiceCommand",
      "privilegedCapture",
      "privilegedInput",
      "processEnumeration",
      "serviceFlavorSeparation",
      "consumerBuildStripping",
      "lifeOpsPersistence",
    ],
  },
  "macos-desktop": {
    label: "macos-desktop-evidence",
    defaultManifest: "docs/macos-desktop-validation.json",
    targetKeys: ["minimumMacos", "requiredPermissions", "driver"],
    completeEvidenceKeys: [
      "machineModel",
      "macosVersion",
      "buildId",
      "validatedAt",
      "validator",
    ],
    checkIds: [
      "capabilityProbe",
      "screenRecordingPermission",
      "screenshotCapture",
      "accessibilityPermission",
      "mouseKeyboardInput",
      "windowListFocus",
      "browserAutomation",
      "clipboardRoundTrip",
      "approvalMode",
    ],
  },
  "linux-desktop": {
    label: "linux-desktop-evidence",
    defaultManifest: "docs/linux-desktop-validation.json",
    targetKeys: ["minimumDistribution", "displayServer", "driver"],
    completeEvidenceKeys: [
      "machineId",
      "distribution",
      "kernelVersion",
      "displayServer",
      "buildId",
      "validatedAt",
      "validator",
    ],
    checkIds: [
      "capabilityProbe",
      "dependencyProbe",
      "screenshotCapture",
      "mouseKeyboardInput",
      "windowListFocus",
      "browserAutomation",
      "clipboardRoundTrip",
      "terminalSafety",
      "approvalMode",
    ],
  },
  "windows-desktop": {
    label: "windows-desktop-evidence",
    defaultManifest: "docs/windows-desktop-validation.json",
    targetKeys: ["minimumWindows", "driver", "shell"],
    completeEvidenceKeys: [
      "machineModel",
      "windowsVersion",
      "buildId",
      "validatedAt",
      "validator",
    ],
    checkIds: [
      "capabilityProbe",
      "screenshotCapture",
      "mouseKeyboardInput",
      "windowListFocus",
      "browserAutomation",
      "clipboardRoundTrip",
      "terminalSafety",
      "approvalMode",
      "windowsHardeningRegression",
    ],
  },
};

function usage() {
  return [
    "Usage: node scripts/validate-platform-evidence.mjs [--require-complete] [manifest ...]",
    "",
    "Validates browser/computer-use platform evidence manifests. With no",
    "manifest arguments, validates all default manifests. With --require-complete,",
    "every check must have passed or be explicitly blocked by platform behavior,",
    "and top-level device/build/validator evidence must be present.",
  ].join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
  );
}

function hasEvidenceValue(value) {
  return nonEmptyString(value) || nonEmptyStringArray(value);
}

function relativeFromHere(here, value) {
  return path.isAbsolute(value) ? value : path.resolve(here, "..", value);
}

function parseArgs(argv) {
  const manifests = [];
  let requireComplete = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--require-complete") {
      requireComplete = true;
      continue;
    }
    manifests.push(arg);
  }
  return { manifests, requireComplete };
}

function validateManifest(manifest, manifestPath, requireComplete) {
  const failures = [];
  const fail = (message) => failures.push(`${manifestPath}: ${message}`);

  if (!isRecord(manifest)) {
    fail("manifest must be an object");
    return failures;
  }
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!nonEmptyString(manifest.platform)) fail("platform must be a string");
  const contract = PLATFORM_CONTRACTS[manifest.platform];
  if (!contract) {
    fail(`unsupported platform: ${manifest.platform}`);
    return failures;
  }
  if (!ALLOWED_STATUSES.has(manifest.status)) {
    fail(`invalid top-level status: ${manifest.status}`);
  }
  if (!isRecord(manifest.target)) {
    fail("target must be an object");
  } else {
    for (const key of contract.targetKeys) {
      if (!hasEvidenceValue(manifest.target[key])) {
        fail(`target.${key} must be a non-empty string or string array`);
      }
    }
  }
  if (!isRecord(manifest.evidence)) {
    fail("evidence must be an object");
  } else if (!Array.isArray(manifest.evidence.artifacts)) {
    fail("evidence.artifacts must be an array");
  }
  if (!Array.isArray(manifest.checks)) {
    fail("checks must be an array");
    return failures;
  }

  const requiredCheckIds = new Set(contract.checkIds);
  const seen = new Set();
  for (const check of manifest.checks) {
    if (!isRecord(check)) {
      fail("each check must be an object");
      continue;
    }
    if (!requiredCheckIds.has(check.id))
      fail(`unexpected check id: ${check.id}`);
    if (seen.has(check.id)) fail(`duplicate check id: ${check.id}`);
    seen.add(check.id);
    if (!nonEmptyString(check.method)) fail(`check ${check.id} missing method`);
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

  for (const id of requiredCheckIds) {
    if (!seen.has(id)) fail(`missing check id: ${id}`);
  }

  if (requireComplete) {
    for (const key of contract.completeEvidenceKeys) {
      if (!hasEvidenceValue(manifest.evidence?.[key])) {
        fail(`--require-complete needs evidence.${key}`);
      }
    }
    if (
      !Array.isArray(manifest.evidence?.artifacts) ||
      manifest.evidence.artifacts.length === 0
    ) {
      fail("--require-complete needs at least one evidence artifact");
    }
    for (const check of manifest.checks) {
      if (!COMPLETE_STATUSES.has(check.status)) {
        fail(`--require-complete: check ${check.id} is ${check.status}`);
      }
    }
  }

  return failures;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const { manifests, requireComplete } = parseArgs(process.argv.slice(2));
const manifestPaths =
  manifests.length > 0
    ? manifests.map((manifest) => relativeFromHere(here, manifest))
    : Object.values(PLATFORM_CONTRACTS).map((contract) =>
        path.resolve(here, "..", contract.defaultManifest),
      );

const failures = [];
const summaries = [];

for (const manifestPath of manifestPaths) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    failures.push(
      `${manifestPath}: failed to read/parse JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    continue;
  }
  failures.push(...validateManifest(manifest, manifestPath, requireComplete));
  const contract = PLATFORM_CONTRACTS[manifest?.platform];
  if (contract && Array.isArray(manifest.checks)) {
    summaries.push(
      `[${contract.label}] ${manifest.checks.length} checks validated (${manifest.status})`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

for (const summary of summaries) console.log(summary);
