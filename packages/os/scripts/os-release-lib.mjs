import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
export const defaultManifestPath = path.join(
  repoRoot,
  "packages/os/release/beta-2026-05-16/manifest.json",
);

const sha256Pattern = /^[a-f0-9]{64}$/;
const artifactKinds = new Set([
  "raw-image",
  "vm-image",
  "android-image",
  "checksum-manifest",
  "usb-installer",
]);
const releaseStatuses = new Set(["planned", "candidate", "available", "withdrawn"]);
const artifactStatuses = new Set(["planned", "candidate", "published", "withdrawn"]);

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
  const requirePublishableChecksums = Boolean(options.requirePublishableChecksums);

  if (manifest?.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  requireString(errors, manifest?.release?.id, "release.id");
  if (manifest?.release?.channel !== "beta") {
    errors.push("release.channel must be beta for the May 2026 beta manifest");
  }
  requireString(errors, manifest?.release?.version, "release.version");
  requireDate(errors, manifest?.release?.availableDate, "release.availableDate");
  if (manifest?.release?.availableDate !== "2026-05-16") {
    errors.push("release.availableDate must be 2026-05-16");
  }
  if (!releaseStatuses.has(manifest?.release?.status)) {
    errors.push("release.status is invalid");
  }

  const presale = manifest?.commerce?.usbKeyPresale;
  if (!presale?.enabled) {
    errors.push("commerce.usbKeyPresale.enabled must be true");
  }
  if (presale?.priceUsd !== 49) {
    errors.push("commerce.usbKeyPresale.priceUsd must be 49");
  }
  if (presale?.saleStarts !== "2026-05-16") {
    errors.push("commerce.usbKeyPresale.saleStarts must be 2026-05-16");
  }
  if (presale?.estimatedShipWindow?.starts !== "2026-10-01") {
    errors.push("commerce.usbKeyPresale.estimatedShipWindow.starts must be 2026-10-01");
  }
  if (presale?.estimatedShipWindow?.ends !== "2026-10-31") {
    errors.push("commerce.usbKeyPresale.estimatedShipWindow.ends must be 2026-10-31");
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
    requireString(errors, artifact?.target?.platform, `${prefix}.target.platform`);
    requireString(errors, artifact?.target?.architecture, `${prefix}.target.architecture`);
    requireString(errors, artifact?.filename, `${prefix}.filename`);
    if (seenFilenames.has(artifact?.filename)) {
      errors.push(`${prefix}.filename duplicates ${artifact.filename}`);
    }
    seenFilenames.add(artifact?.filename);
    requireString(errors, artifact?.downloadUrl, `${prefix}.downloadUrl`);

    if (artifact?.sha256 !== null && !sha256Pattern.test(artifact?.sha256 ?? "")) {
      errors.push(`${prefix}.sha256 must be null or 64 lowercase hex characters`);
    }
    if (artifact?.sizeBytes !== null && (!Number.isInteger(artifact?.sizeBytes) || artifact.sizeBytes <= 0)) {
      errors.push(`${prefix}.sizeBytes must be null or a positive integer`);
    }
    if (requirePublishableChecksums && artifact?.status !== "withdrawn") {
      if (!sha256Pattern.test(artifact?.sha256 ?? "")) {
        errors.push(`${prefix}.sha256 is required for publishable validation`);
      }
      if (!Number.isInteger(artifact?.sizeBytes) || artifact.sizeBytes <= 0) {
        errors.push(`${prefix}.sizeBytes is required for publishable validation`);
      }
    }
    if (!Array.isArray(artifact?.validation?.requiredEvidence)) {
      errors.push(`${prefix}.validation.requiredEvidence must be an array`);
    }
    if (!Array.isArray(artifact?.validation?.evidence)) {
      errors.push(`${prefix}.validation.evidence must be an array`);
    }
    if ((artifact?.validation?.requiredEvidence ?? []).includes("sha256-generated") && !artifact.sha256) {
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
  requireString(errors, manifest?.checksumPolicy?.generatedFile, "checksumPolicy.generatedFile");
  requireString(errors, manifest?.checksumPolicy?.verificationScript, "checksumPolicy.verificationScript");
  requireString(errors, manifest?.validation?.evidenceDirectory, "validation.evidenceDirectory");
  if (!Array.isArray(manifest?.validation?.promotionGates)) {
    errors.push("validation.promotionGates must be an array");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
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
