import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const repoRoot = path.resolve(
  new URL("../../..", import.meta.url).pathname,
);
export const defaultManifestPath = path.join(
  repoRoot,
  "packages/os/release/beta-2026-05-16/manifest.json",
);

const sha256Pattern = /^[a-f0-9]{64}$/;
const zeroSha256 = "0".repeat(64);

function isPlaceholderSha256(value) {
  return value === zeroSha256;
}
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const releaseChannels = new Set(["alpha", "beta", "stable", "nightly"]);
const artifactKinds = new Set([
  "raw-image",
  "vm-image",
  "android-image",
  "checksum-manifest",
  "usb-installer",
]);
const releaseStatuses = new Set([
  "planned",
  "candidate",
  "available",
  "withdrawn",
]);
const artifactStatuses = new Set([
  "planned",
  "candidate",
  "published",
  "withdrawn",
]);
const teeProviders = new Set([
  "dstack",
  "tdx",
  "sev-snp",
  "nitro",
  "cove",
  "keystone",
  "optee",
  "eliza-vault",
]);

// Measurement names always required in a TEE-capable measurement set.
export const requiredTeeMeasurementNames = ["boot", "os", "agent", "policy"];

// Optional OS-side measurement names. These mirror the agent's canonical
// `TeeMeasurementName` union (packages/agent/src/services/tee-evidence.ts) plus
// the OS-only `modelWeights` and `monitor` measurements. The agent type accepts
// arbitrary names via its `(string & {})` fallback, so all of these round-trip
// through normalizeTeeEvidence without an agent-side change.
export const optionalTeeMeasurementNames = [
  "device",
  "container",
  "compose",
  "gpuFirmware",
  "npuFirmware",
  "modelWeights",
  "monitor",
];

// Conditionally-required claims for on-device confidential inference: when the
// manifest declares an inference-bearing measurement, npuProtected and
// ioProtected must be asserted (plan §6, OS-2/OS-3).
const inferenceMeasurementNames = [
  "gpuFirmware",
  "npuFirmware",
  "modelWeights",
];

function isValidIsoDate(value) {
  if (typeof value !== "string" || !isoDatePattern.test(value)) {
    return false;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._ = [...(args._ ?? []), arg];
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

// Deterministic canonicalization: recursively sort object keys, preserve array
// order. The result serializes to identical bytes regardless of the source file's
// key ordering or whitespace, so the policy digest depends only on the policy's
// semantic content. Arrays are NOT reordered (order is meaningful for the policy).
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

// sha256 of the canonical JSON serialization of `value`, prefixed `sha256:`.
// This is the digest folded into measurements.policy: the confidential-policy.json
// bytes (canonicalized) ARE the policy measurement.
export function sha256CanonicalJson(value) {
  const bytes = JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

export function artifactPath(artifactRoot, artifact) {
  return path.join(artifactRoot, artifact.filename);
}

export async function artifactFileRecord(artifactRoot, artifact) {
  const filePath = artifactPath(artifactRoot, artifact);
  const stats = await stat(filePath);
  return {
    id: artifact.id,
    filename: artifact.filename,
    path: filePath,
    sizeBytes: stats.size,
    sha256: await sha256File(filePath),
  };
}

function requireString(errors, value, field) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function requireDate(errors, value, field) {
  requireString(errors, value, field);
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${field} must use YYYY-MM-DD`);
  }
}

export function validateManifest(manifest, options = {}) {
  const errors = [];
  const warnings = [];
  const requirePublishableChecksums = Boolean(
    options.requirePublishableChecksums,
  );

  if (manifest?.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  requireString(errors, manifest?.release?.id, "release.id");
  if (!releaseChannels.has(manifest?.release?.channel)) {
    errors.push(
      `release.channel must be one of ${[...releaseChannels].join(", ")}`,
    );
  }
  requireString(errors, manifest?.release?.version, "release.version");
  requireDate(
    errors,
    manifest?.release?.availableDate,
    "release.availableDate",
  );
  if (
    typeof manifest?.release?.availableDate === "string" &&
    !isValidIsoDate(manifest.release.availableDate)
  ) {
    errors.push("release.availableDate must be a valid ISO date (YYYY-MM-DD)");
  }
  if (!releaseStatuses.has(manifest?.release?.status)) {
    errors.push("release.status is invalid");
  }

  const presale = manifest?.commerce?.usbKeyPresale;
  if (!presale?.enabled) {
    errors.push("commerce.usbKeyPresale.enabled must be true");
  }
  if (typeof presale?.priceUsd !== "number" || presale.priceUsd <= 0) {
    errors.push("commerce.usbKeyPresale.priceUsd must be a positive number");
  }
  if (!isValidIsoDate(presale?.saleStarts)) {
    errors.push("commerce.usbKeyPresale.saleStarts must be a valid ISO date");
  }
  if (!isValidIsoDate(presale?.estimatedShipWindow?.starts)) {
    errors.push(
      "commerce.usbKeyPresale.estimatedShipWindow.starts must be a valid ISO date",
    );
  }
  if (!isValidIsoDate(presale?.estimatedShipWindow?.ends)) {
    errors.push(
      "commerce.usbKeyPresale.estimatedShipWindow.ends must be a valid ISO date",
    );
  }

  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0) {
    errors.push("artifacts must be a non-empty array");
  }

  const requiredKinds = new Set(["raw-image", "vm-image", "android-image"]);
  const seenKinds = new Set();
  const seenIds = new Set();
  const seenFilenames = new Set();

  for (const [index, artifact] of (manifest.artifacts ?? []).entries()) {
    const prefix = `artifacts[${index}]`;
    requireString(errors, artifact?.id, `${prefix}.id`);
    if (seenIds.has(artifact?.id)) {
      errors.push(`${prefix}.id duplicates ${artifact.id}`);
    }
    seenIds.add(artifact?.id);

    if (!artifactKinds.has(artifact?.kind)) {
      errors.push(`${prefix}.kind is invalid`);
    } else {
      seenKinds.add(artifact.kind);
    }
    if (!artifactStatuses.has(artifact?.status)) {
      errors.push(`${prefix}.status is invalid`);
    }
    requireString(
      errors,
      artifact?.target?.platform,
      `${prefix}.target.platform`,
    );
    requireString(
      errors,
      artifact?.target?.architecture,
      `${prefix}.target.architecture`,
    );
    requireString(errors, artifact?.filename, `${prefix}.filename`);
    if (seenFilenames.has(artifact?.filename)) {
      errors.push(`${prefix}.filename duplicates ${artifact.filename}`);
    }
    seenFilenames.add(artifact?.filename);
    const hasDownloadUrl =
      typeof artifact?.downloadUrl === "string" &&
      artifact.downloadUrl.length > 0;
    if (artifact?.downloadUrl !== null && !hasDownloadUrl) {
      errors.push(`${prefix}.downloadUrl must be null or a non-empty string`);
    }
    if (artifact?.status === "published" && !hasDownloadUrl) {
      errors.push(`${prefix}.downloadUrl is required for published artifacts`);
    } else if (!hasDownloadUrl) {
      warnings.push(`${artifact.id} is awaiting download URL`);
    }

    if (
      artifact?.sha256 !== null &&
      !sha256Pattern.test(artifact?.sha256 ?? "")
    ) {
      errors.push(
        `${prefix}.sha256 must be null or 64 lowercase hex characters`,
      );
    }
    if (isPlaceholderSha256(artifact?.sha256)) {
      errors.push(
        `${prefix}.sha256 is an all-zero placeholder; use null until a real checksum is generated`,
      );
    }
    if (
      artifact?.sizeBytes !== null &&
      (!Number.isInteger(artifact?.sizeBytes) || artifact.sizeBytes <= 0)
    ) {
      errors.push(`${prefix}.sizeBytes must be null or a positive integer`);
    }
    if (requirePublishableChecksums && artifact?.status !== "withdrawn") {
      if (!hasDownloadUrl) {
        errors.push(
          `${prefix}.downloadUrl is required for publishable validation`,
        );
      }
      if (
        !sha256Pattern.test(artifact?.sha256 ?? "") ||
        isPlaceholderSha256(artifact?.sha256)
      ) {
        errors.push(`${prefix}.sha256 is required for publishable validation`);
      }
      if (!Number.isInteger(artifact?.sizeBytes) || artifact.sizeBytes <= 0) {
        errors.push(
          `${prefix}.sizeBytes is required for publishable validation`,
        );
      }
    }
    if (!Array.isArray(artifact?.validation?.requiredEvidence)) {
      errors.push(`${prefix}.validation.requiredEvidence must be an array`);
    }
    if (!Array.isArray(artifact?.validation?.evidence)) {
      errors.push(`${prefix}.validation.evidence must be an array`);
    }
    if (
      (artifact?.validation?.requiredEvidence ?? []).includes(
        "sha256-generated",
      ) &&
      !artifact.sha256
    ) {
      warnings.push(`${artifact.id} is awaiting sha256 generation`);
    }
  }

  for (const kind of requiredKinds) {
    if (!seenKinds.has(kind)) {
      errors.push(`artifacts must include at least one ${kind}`);
    }
  }

  if (manifest?.checksumPolicy?.algorithm !== "sha256") {
    errors.push("checksumPolicy.algorithm must be sha256");
  }
  requireString(
    errors,
    manifest?.checksumPolicy?.generatedFile,
    "checksumPolicy.generatedFile",
  );
  requireString(
    errors,
    manifest?.checksumPolicy?.verificationScript,
    "checksumPolicy.verificationScript",
  );
  requireString(
    errors,
    manifest?.validation?.evidenceDirectory,
    "validation.evidenceDirectory",
  );
  if (!Array.isArray(manifest?.validation?.promotionGates)) {
    errors.push("validation.promotionGates must be an array");
  }
  validateTeePolicy(errors, manifest?.tee);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateTeeMeasurements(document) {
  const errors = [];
  if (document?.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (typeof document?.generatedBy !== "string" || !document.generatedBy) {
    errors.push("generatedBy must be a non-empty string");
  }
  const measurements = document?.measurements;
  if (!measurements || typeof measurements !== "object") {
    errors.push("measurements must be an object");
    return { ok: false, errors };
  }
  const knownNames = new Set([
    ...requiredTeeMeasurementNames,
    ...optionalTeeMeasurementNames,
  ]);
  for (const field of requiredTeeMeasurementNames) {
    if (!sha256DigestString(measurements[field])) {
      errors.push(`measurements.${field} must be sha256:<64 lowercase hex>`);
    }
  }
  for (const [field, digest] of Object.entries(measurements)) {
    if (!knownNames.has(field)) {
      errors.push(`measurements.${field} is not a known measurement name`);
      continue;
    }
    if (!sha256DigestString(digest)) {
      errors.push(`measurements.${field} must be sha256:<64 lowercase hex>`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateTeePolicy(errors, tee) {
  if (tee === undefined) return;
  if (!tee || typeof tee !== "object" || Array.isArray(tee)) {
    errors.push("tee must be an object when present");
    return;
  }
  if (typeof tee.enabled !== "boolean") {
    errors.push("tee.enabled must be a boolean");
  }
  if (tee.enabled !== true) return;
  if (!sha256DigestString(tee.policyDigest)) {
    errors.push("tee.policyDigest must be sha256:<64 lowercase hex>");
  }
  if (!Array.isArray(tee.providers) || tee.providers.length === 0) {
    errors.push("tee.providers must be a non-empty array when enabled");
  } else {
    for (const provider of tee.providers) {
      if (!teeProviders.has(provider)) {
        errors.push(`tee.providers contains unsupported provider ${provider}`);
      }
    }
  }
  const measurements = tee.measurements;
  if (
    !measurements ||
    typeof measurements !== "object" ||
    Array.isArray(measurements)
  ) {
    errors.push("tee.measurements must be an object when enabled");
    return;
  }
  const knownNames = new Set([
    ...requiredTeeMeasurementNames,
    ...optionalTeeMeasurementNames,
  ]);
  // Fail closed: a declared TEE-capable manifest missing any required digest is
  // rejected, never silently accepted.
  for (const field of requiredTeeMeasurementNames) {
    if (!sha256DigestString(measurements[field])) {
      errors.push(
        `tee.measurements.${field} must be sha256:<64 lowercase hex>`,
      );
    }
  }
  for (const [field, digest] of Object.entries(measurements)) {
    if (!knownNames.has(field)) {
      errors.push(`tee.measurements.${field} is not a known measurement name`);
      continue;
    }
    if (!sha256DigestString(digest)) {
      errors.push(
        `tee.measurements.${field} must be sha256:<64 lowercase hex>`,
      );
    }
  }
  const requiredClaims = tee.requiredClaims;
  if (
    requiredClaims === undefined ||
    !requiredClaims ||
    typeof requiredClaims !== "object" ||
    Array.isArray(requiredClaims)
  ) {
    errors.push("tee.requiredClaims must be an object when enabled");
    return;
  }
  for (const claim of ["debugDisabled", "secureBoot"]) {
    if (requiredClaims[claim] !== true) {
      errors.push(`tee.requiredClaims.${claim} must be true when enabled`);
    }
  }
  // On-device confidential inference: any inference-bearing measurement requires
  // npuProtected + ioProtected to be asserted (plan §6 / OS-2 / OS-3).
  const declaresInference = inferenceMeasurementNames.some((name) =>
    sha256DigestString(measurements[name]),
  );
  if (declaresInference) {
    for (const claim of ["npuProtected", "ioProtected"]) {
      if (requiredClaims[claim] !== true) {
        errors.push(
          `tee.requiredClaims.${claim} must be true when an inference measurement (gpuFirmware/npuFirmware/modelWeights) is declared`,
        );
      }
    }
  }
}

function sha256DigestString(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function formatCheckEntry(record) {
  return `${record.sha256}  ${record.filename}`;
}

export function parseChecksumFile(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
      if (!match) {
        throw new Error(`Invalid checksum line: ${line}`);
      }
      return { sha256: match[1], filename: match[2] };
    });
}
