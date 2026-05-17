#!/usr/bin/env node
import { readFile } from "node:fs/promises";
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
const artifactRoot = path.resolve(args["artifact-root"] || path.dirname(manifestPath));
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

const checksumRecords = parseChecksumFile(await readFile(checksumsPath, "utf8"));
const checksumByFilename = new Map(
  checksumRecords.map((record) => [record.filename, record.sha256]),
);

const failures = [];
let verified = 0;
for (const artifact of manifest.artifacts) {
  if (artifact.kind === "checksum-manifest" || artifact.status === "withdrawn") {
    continue;
  }

  const expected = checksumByFilename.get(artifact.filename) || artifact.sha256;
  if (!expected) {
    failures.push(`${artifact.filename}: missing expected checksum`);
    continue;
  }

  const filePath = artifactPath(artifactRoot, artifact);
  if (!(await fileExists(filePath))) {
    failures.push(`${artifact.filename}: file not found under ${artifactRoot}`);
    continue;
  }

  const actual = await sha256File(filePath);
  if (actual !== expected) {
    failures.push(`${artifact.filename}: checksum mismatch expected=${expected} actual=${actual}`);
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
