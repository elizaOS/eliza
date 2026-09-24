#!/usr/bin/env node
// Supports OS release manifests, checksums, and TEE evidence automation.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactPath,
  defaultManifestPath,
  fileExists,
  parseArgs,
  parseChecksumFile,
  readJson,
  sha256File,
  validateManifest,
} from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest || defaultManifestPath;
const artifactRoot = path.resolve(
  args["artifact-root"] || path.dirname(manifestPath),
);
const checksumsPath = path.resolve(
  args.checksums || path.join(path.dirname(manifestPath), "SHA256SUMS"),
);

const manifest = await readJson(manifestPath);
const validation = validateManifest(manifest);
if (!validation.ok) {
  for (const error of validation.errors) {
    console.error(`error: ${error}`);
  }
  process.exit(1);
}

const checksumRecords = parseChecksumFile(
  await readFile(checksumsPath, "utf8"),
);
const failures = [];
const checksumByFilename = new Map();
for (const record of checksumRecords) {
  if (checksumByFilename.has(record.filename)) {
    failures.push(`${record.filename}: duplicate checksum entry`);
    continue;
  }
  checksumByFilename.set(record.filename, record.sha256);
}

const activeArtifacts = manifest.artifacts.filter(
  (artifact) =>
    artifact.kind !== "checksum-manifest" && artifact.status !== "withdrawn",
);
const activeFilenames = new Set(
  activeArtifacts.map((artifact) => artifact.filename),
);
for (const filename of checksumByFilename.keys()) {
  if (!activeFilenames.has(filename)) {
    failures.push(
      `${filename}: checksum entry is not declared by the manifest`,
    );
  }
}

let verified = 0;
for (const artifact of activeArtifacts) {
  const checksumDigest = checksumByFilename.get(artifact.filename);
  if (!checksumDigest) {
    failures.push(`${artifact.filename}: missing SHA256SUMS entry`);
    continue;
  }
  if (artifact.sha256 && artifact.sha256 !== checksumDigest) {
    failures.push(
      `${artifact.filename}: manifest checksum disagrees with SHA256SUMS`,
    );
    continue;
  }

  const filePath = artifactPath(artifactRoot, artifact);
  if (!(await fileExists(filePath))) {
    failures.push(`${artifact.filename}: file not found under ${artifactRoot}`);
    continue;
  }
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    failures.push(`${artifact.filename}: expected a regular non-symlink file`);
    continue;
  }
  if (
    Number.isInteger(artifact.sizeBytes) &&
    artifact.sizeBytes !== stats.size
  ) {
    failures.push(
      `${artifact.filename}: size mismatch expected=${artifact.sizeBytes} actual=${stats.size}`,
    );
    continue;
  }

  const actual = await sha256File(filePath);
  if (actual !== checksumDigest) {
    failures.push(
      `${artifact.filename}: checksum mismatch expected=${checksumDigest} actual=${actual}`,
    );
    continue;
  }
  verified += 1;
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`error: ${failure}`);
  }
  process.exit(1);
}

console.log(`Verified ${verified} artifacts against ${checksumsPath}`);
