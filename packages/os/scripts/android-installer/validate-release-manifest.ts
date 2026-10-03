#!/usr/bin/env node
// Validates Android release manifests before installer artifacts are shipped.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const DEFAULT_ARTIFACT_DIR = "release/android/partitions";
const hardwareInventory = readJson(
  new URL("../../android/hardware-targets.json", import.meta.url),
);
const hardwareTargetsById = new Map(
  (hardwareInventory.targets ?? []).map((target) => [target.targetId, target]),
);
const REQUIRED_VALIDATION_TOKENS = [
  "pm path",
  "cmd role get-role-holders",
  "foreground",
  "service",
  "/api/health",
  "logcat",
  "selinux",
];

function usage() {
  console.log(`Usage:
  validate-release-manifest.ts MANIFEST.json [--artifact-dir DIR] [--allow-placeholders] [--write-evidence FILE]

Validates the Android release manifest shape without requiring devices.
When --artifact-dir is provided, artifact sizes and SHA-256 hashes are checked.
When --write-evidence is provided, writes a machine-readable integrity report.
Use --allow-placeholders only for checked-in pre-release draft manifests.`);
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let manifestPath = "";
  let artifactDir = "";
  let writeEvidence = "";
  let allowPlaceholders = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--artifact-dir") {
      artifactDir = argv[index + 1] ?? "";
      if (!artifactDir) die("--artifact-dir requires a directory");
      index += 1;
      continue;
    }
    if (arg === "--allow-placeholders") {
      allowPlaceholders = true;
      continue;
    }
    if (arg === "--write-evidence") {
      writeEvidence = argv[index + 1] ?? "";
      if (!writeEvidence) die("--write-evidence requires a file path");
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) die(`unknown argument: ${arg}`);
    if (manifestPath) die(`unexpected extra argument: ${arg}`);
    manifestPath = arg;
  }
  if (!manifestPath) die("provide a manifest path");
  return { manifestPath, artifactDir, allowPlaceholders, writeEvidence };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    die(`failed to read JSON ${path}: ${error.message}`);
  }
}

function expect(condition, errors, path, message) {
  if (!condition) errors.push(`${path}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function artifactIntegrityDirectory(manifest, artifactDir) {
  if (artifactDir) return artifactDir;
  const integrity = manifest.validation?.artifactIntegrity;
  if (isObject(integrity) && typeof integrity.artifactDirectory === "string") {
    return integrity.artifactDirectory;
  }
  return DEFAULT_ARTIFACT_DIR;
}

function releaseArtifactInstructions(
  manifest,
  artifactDir,
  manifestPath = "MANIFEST.json",
) {
  const stageDir = artifactIntegrityDirectory(manifest, artifactDir);
  const requiredFiles = (manifest.artifacts ?? [])
    .map((artifact) => artifact?.filename)
    .filter((filename) => typeof filename === "string" && filename.length > 0);
  const device = (manifest.supportedDevices ?? []).find(
    (candidate) =>
      isObject(candidate) &&
      /^[a-z0-9_]+$/.test(String(candidate.codename ?? "")),
  );
  const codename = String(device?.codename ?? "DEVICE_CODENAME");
  const inventoryTarget = hardwareTargetsById.get(device?.targetId);
  const productName =
    typeof inventoryTarget?.productName === "string"
      ? inventoryTarget.productName
      : `eliza_${codename}_phone`;
  const productOut = `$AOSP_WORKSPACE/out/target/product/${productName}`;
  const copyCommands = requiredFiles.map(
    (filename) => `cp "${productOut}/${filename}" "${stageDir}/${filename}"`,
  );
  return {
    applies_to: productName,
    build_commands: [],
    blocked_reason: inventoryTarget?.installerEligible
      ? null
      : Array.isArray(inventoryTarget?.blockedReasons)
        ? inventoryTarget.blockedReasons.join(" ")
        : "The hardware target is not installer-eligible in android/hardware-targets.json.",
    stage_commands: [`mkdir -p "${stageDir}"`, ...copyCommands],
    manifest_update_commands: [
      `stat -c '%n %s' "${stageDir}"/*.img`,
      `sha256sum "${stageDir}"/*.img`,
      "replace each artifacts[].sizeBytes and artifacts[].sha256 with those exact values; do not use placeholders or copied hashes",
    ],
    validate_commands: [
      `node scripts/android-installer/validate-release-manifest.ts "${manifestPath}" --artifact-dir "${stageDir}" --write-evidence evidence/android-partition-artifacts-integrity.json`,
    ],
    provenance_requirements: [
      `AOSP workspace path and ${inventoryTarget?.aospLockPath ?? "the selected AOSP lock"} digest`,
      `lunch target ${productName}-trunk_staging-userdebug`,
      "elizaOS/eliza source commit used for the retained application",
      "product_out_dir used as source for staged images",
      "per-file byte size and SHA-256 computed from staged boot/vendor_boot/super images",
      "evidence JSON from this validator with status=pass",
    ],
  };
}

function instructionSummary(instructions) {
  return [
    `blocked: ${instructions.blocked_reason ?? "no"}`,
    `build: ${instructions.build_commands.join(" && ")}`,
    `stage: ${instructions.stage_commands.join(" && ")}`,
    `validate: ${instructions.validate_commands.join(" && ")}`,
    `provenance: ${instructions.provenance_requirements.join("; ")}`,
  ].join(" | ");
}

function validateManifest(manifest, { allowPlaceholders = false } = {}) {
  const errors = [];
  expect(isObject(manifest), errors, "$", "manifest must be an object");
  if (!isObject(manifest)) return errors;

  expect(manifest.schemaVersion === 1, errors, "$.schemaVersion", "must be 1");
  expect(
    typeof manifest.releaseId === "string" && manifest.releaseId.length > 0,
    errors,
    "$.releaseId",
    "must be a non-empty string",
  );
  expect(
    typeof manifest.generatedAt === "string" &&
      !Number.isNaN(Date.parse(manifest.generatedAt)),
    errors,
    "$.generatedAt",
    "must be an ISO date-time string",
  );
  expect(
    typeof manifest.buildFingerprint === "string" &&
      manifest.buildFingerprint.length > 0,
    errors,
    "$.buildFingerprint",
    "must be a non-empty string",
  );

  const validBuildTypes = new Set(["user", "userdebug", "eng", "unknown"]);
  if (manifest.buildType !== undefined) {
    expect(
      validBuildTypes.has(manifest.buildType),
      errors,
      "$.buildType",
      "must be user, userdebug, eng, or unknown",
    );
  }

  expect(
    Array.isArray(manifest.supportedDevices) &&
      manifest.supportedDevices.length > 0,
    errors,
    "$.supportedDevices",
    "must be a non-empty array",
  );
  const deviceCodenames = new Set();
  const tiers = new Set(["lab-validated", "candidate", "manual", "blocked"]);
  const slotValues = new Set(["a", "b", "none"]);
  if (Array.isArray(manifest.supportedDevices)) {
    manifest.supportedDevices.forEach((device, index) => {
      const path = `$.supportedDevices[${index}]`;
      expect(isObject(device), errors, path, "must be an object");
      if (!isObject(device)) return;
      expect(
        typeof device.targetId === "string" &&
          /^[a-zA-Z0-9._-]+$/.test(device.targetId),
        errors,
        `${path}.targetId`,
        "must be a stable hardware target id",
      );
      const inventoryTarget = hardwareTargetsById.get(device.targetId);
      expect(
        isObject(inventoryTarget) &&
          Array.isArray(inventoryTarget.codenames) &&
          inventoryTarget.codenames.includes(device.codename),
        errors,
        `${path}.targetId`,
        "must map this codename in android/hardware-targets.json",
      );
      if (typeof inventoryTarget?.expectedFingerprintPrefix === "string") {
        expect(
          manifest.buildFingerprint.startsWith(
            inventoryTarget.expectedFingerprintPrefix,
          ),
          errors,
          "$.buildFingerprint",
          `must start with ${inventoryTarget.expectedFingerprintPrefix}`,
        );
        expect(
          manifest.validation?.expectedFingerprintPrefix ===
            inventoryTarget.expectedFingerprintPrefix,
          errors,
          "$.validation.expectedFingerprintPrefix",
          `must equal ${inventoryTarget.expectedFingerprintPrefix}`,
        );
      }
      expect(
        typeof device.codename === "string" &&
          /^[a-zA-Z0-9._-]+$/.test(device.codename),
        errors,
        `${path}.codename`,
        "must be a valid codename",
      );
      if (deviceCodenames.has(device.codename))
        errors.push(`${path}.codename: duplicate codename ${device.codename}`);
      deviceCodenames.add(device.codename);
      expect(
        tiers.has(device.tier),
        errors,
        `${path}.tier`,
        "must be lab-validated, candidate, manual, or blocked",
      );
      if (device.tier === "lab-validated") {
        expect(
          inventoryTarget?.installerEligible === true,
          errors,
          `${path}.tier`,
          "cannot be lab-validated while this target is installer-ineligible in android/hardware-targets.json",
        );
      }
      expect(
        Array.isArray(device.slots) && device.slots.length > 0,
        errors,
        `${path}.slots`,
        "must be a non-empty array",
      );
      if (Array.isArray(device.slots)) {
        device.slots.forEach((slot) => {
          expect(
            slotValues.has(slot),
            errors,
            `${path}.slots`,
            `invalid slot ${slot}`,
          );
        });
      }
      expect(
        typeof device.dynamicPartitions === "boolean",
        errors,
        `${path}.dynamicPartitions`,
        "must be boolean",
      );
      expect(
        typeof device.rollbackSupported === "boolean",
        errors,
        `${path}.rollbackSupported`,
        "must be boolean",
      );
    });
  }

  expect(
    Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0,
    errors,
    "$.artifacts",
    "must be a non-empty array",
  );
  const partitions = new Set();
  const fastbootModes = new Set(["bootloader", "fastbootd"]);
  if (Array.isArray(manifest.artifacts)) {
    manifest.artifacts.forEach((artifact, index) => {
      const path = `$.artifacts[${index}]`;
      expect(isObject(artifact), errors, path, "must be an object");
      if (!isObject(artifact)) return;
      expect(
        typeof artifact.partition === "string" &&
          /^[a-zA-Z0-9._-]+$/.test(artifact.partition),
        errors,
        `${path}.partition`,
        "must be a valid partition name",
      );
      if (partitions.has(artifact.partition))
        errors.push(
          `${path}.partition: duplicate partition ${artifact.partition}`,
        );
      partitions.add(artifact.partition);
      expect(
        typeof artifact.filename === "string" &&
          /^[^/\\]+\.img$/.test(artifact.filename),
        errors,
        `${path}.filename`,
        "must be a local .img filename",
      );
      expect(
        typeof artifact.partition !== "string" ||
          artifact.filename === `${artifact.partition}.img`,
        errors,
        `${path}.filename`,
        "must use the canonical <partition>.img filename so the installer flashes the validated bytes",
      );
      expect(
        typeof artifact.sha256 === "string" &&
          /^[a-fA-F0-9]{64}$/.test(artifact.sha256),
        errors,
        `${path}.sha256`,
        "must be 64 hex characters",
      );
      if (!allowPlaceholders) {
        expect(
          typeof artifact.sha256 !== "string" ||
            artifact.sha256.toLowerCase() !== "0".repeat(64),
          errors,
          `${path}.sha256`,
          "must not be the all-zero placeholder; populate with a real checksum before validating",
        );
      }
      expect(
        Number.isInteger(artifact.sizeBytes) && artifact.sizeBytes > 0,
        errors,
        `${path}.sizeBytes`,
        "must be a positive integer",
      );
      if (!allowPlaceholders) {
        expect(
          !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes > 1,
          errors,
          `${path}.sizeBytes`,
          "must not be the sentinel value 1; populate with the real artifact size",
        );
      }
      expect(
        typeof artifact.required === "boolean",
        errors,
        `${path}.required`,
        "must be boolean",
      );
      expect(
        fastbootModes.has(artifact.fastbootMode),
        errors,
        `${path}.fastbootMode`,
        "must be bootloader or fastbootd",
      );
    });
  }

  expect(
    isObject(manifest.validation),
    errors,
    "$.validation",
    "must be an object",
  );
  if (isObject(manifest.validation)) {
    expect(
      Number.isInteger(manifest.validation.bootTimeoutSeconds) &&
        manifest.validation.bootTimeoutSeconds >= 30,
      errors,
      "$.validation.bootTimeoutSeconds",
      "must be an integer >= 30",
    );
    expect(
      isObject(manifest.validation.properties),
      errors,
      "$.validation.properties",
      "must be an object",
    );
    if (isObject(manifest.validation.properties)) {
      Object.entries(manifest.validation.properties).forEach(([key, value]) => {
        expect(
          typeof value === "string",
          errors,
          `$.validation.properties.${key}`,
          "must be a string",
        );
      });
    }
    expect(
      Array.isArray(manifest.validation.requiredValidationTokens) &&
        manifest.validation.requiredValidationTokens.length > 0 &&
        new Set(manifest.validation.requiredValidationTokens).size ===
          manifest.validation.requiredValidationTokens.length &&
        manifest.validation.requiredValidationTokens.every(
          (token) => typeof token === "string" && token.length > 0,
        ),
      errors,
      "$.validation.requiredValidationTokens",
      "must be a non-empty unique string array",
    );
    if (Array.isArray(manifest.validation.requiredValidationTokens)) {
      for (const token of REQUIRED_VALIDATION_TOKENS) {
        expect(
          manifest.validation.requiredValidationTokens.includes(token),
          errors,
          "$.validation.requiredValidationTokens",
          `must include ${JSON.stringify(token)}`,
        );
      }
    }
  }

  expect(
    isObject(manifest.rollback),
    errors,
    "$.rollback",
    "must be an object",
  );
  if (isObject(manifest.rollback)) {
    expect(
      typeof manifest.rollback.previousReleaseId === "string" &&
        manifest.rollback.previousReleaseId.length > 0,
      errors,
      "$.rollback.previousReleaseId",
      "must identify a retained known-good release",
    );
    expect(
      typeof manifest.rollback.notes === "string" &&
        manifest.rollback.notes.length > 0,
      errors,
      "$.rollback.notes",
      "must describe the rollback procedure or retained artifacts",
    );
  }

  return errors;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspectArtifacts(manifest, artifactDir) {
  const records = [];
  if (!artifactDir) return records;
  for (const artifact of manifest.artifacts ?? []) {
    const artifactPath = join(artifactDir, artifact.filename);
    let stats;
    try {
      stats = statSync(artifactPath);
    } catch {
      records.push({
        partition: artifact.partition,
        filename: artifact.filename,
        path: artifactPath,
        status: "missing",
        manifestSizeBytes: artifact.sizeBytes,
        manifestSha256: artifact.sha256,
      });
      continue;
    }
    const sha256 = sha256File(artifactPath);
    const sizeMatches = stats.size === artifact.sizeBytes;
    const sha256Matches =
      typeof artifact.sha256 === "string" &&
      sha256.toLowerCase() === artifact.sha256.toLowerCase();
    records.push({
      partition: artifact.partition,
      filename: artifact.filename,
      path: artifactPath,
      status: sizeMatches && sha256Matches ? "verified" : "mismatch",
      sizeBytes: stats.size,
      sha256,
      manifestSizeBytes: artifact.sizeBytes,
      manifestSha256: artifact.sha256,
      sizeMatches,
      sha256Matches,
    });
  }
  return records;
}

function validateArtifacts(
  manifest,
  artifactDir,
  manifestPath = "MANIFEST.json",
) {
  const errors = [];
  if (artifactDir) {
    const declaredImages = new Set(
      (manifest.artifacts ?? [])
        .map((artifact) => artifact?.filename)
        .filter((filename) => typeof filename === "string"),
    );
    let directoryEntries = [];
    try {
      directoryEntries = readdirSync(artifactDir);
    } catch (error) {
      errors.push(
        `${artifactDir}: cannot read artifact directory: ${error.message}`,
      );
    }
    for (const filename of directoryEntries.filter((entry) =>
      entry.endsWith(".img"),
    )) {
      if (!declaredImages.has(filename)) {
        errors.push(
          `${join(artifactDir, filename)}: image is not declared by the release manifest`,
        );
      }
    }
  }
  for (const artifact of inspectArtifacts(manifest, artifactDir)) {
    if (artifact.status === "missing") {
      errors.push(`${artifact.path}: artifact file not found`);
      continue;
    }
    if (!artifact.sizeMatches) {
      errors.push(
        `${artifact.path}: size ${artifact.sizeBytes} does not match manifest ${artifact.manifestSizeBytes}`,
      );
    }
    if (!artifact.sha256Matches) {
      errors.push(
        `${artifact.path}: sha256 ${artifact.sha256} does not match manifest ${artifact.manifestSha256}`,
      );
    }
  }
  if (errors.length > 0) {
    errors.push(
      `artifact staging instructions: ${instructionSummary(
        releaseArtifactInstructions(manifest, artifactDir, manifestPath),
      )}`,
    );
  }
  return errors;
}

function writeEvidenceFile(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const { manifestPath, artifactDir, allowPlaceholders, writeEvidence } =
  parseArgs(args);
const manifest = readJson(manifestPath);
const errors = [
  ...validateManifest(manifest, { allowPlaceholders }),
  ...validateArtifacts(manifest, artifactDir, manifestPath),
];
if (writeEvidence) {
  writeEvidenceFile(writeEvidence, {
    schema: "eliza.android_release_partition_artifacts_integrity.v1",
    status: errors.length === 0 ? "pass" : "blocked",
    claim_boundary:
      "android_partition_artifact_size_sha256_static_integrity_only_not_flash_or_runtime_evidence",
    manifest: manifestPath,
    artifact_directory: artifactDir || null,
    allow_placeholders: allowPlaceholders,
    release_id: manifest.releaseId ?? null,
    artifacts: inspectArtifacts(manifest, artifactDir),
    release_artifact_instructions: releaseArtifactInstructions(
      manifest,
      artifactDir,
      manifestPath,
    ),
    errors,
  });
}
if (errors.length > 0) {
  errors.forEach((error) => {
    console.error(`error: ${error}`);
  });
  process.exit(1);
}

console.log(`manifest ok: ${manifest.releaseId}`);
if (artifactDir) console.log(`artifacts ok: ${artifactDir}`);
