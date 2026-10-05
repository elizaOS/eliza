#!/usr/bin/env node
// Populate missing artifact digests only after every required file is readable.
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactFileRecord,
  parseArgs,
  readJson,
  validateManifest,
} from "./os-release-lib.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args["artifacts-dir"]) {
  throw new Error(
    "Usage: update-manifest-checksums.ts --manifest <path> --artifacts-dir <dir>",
  );
}
const manifestPath = path.resolve(args.manifest);
const manifest = await readJson(manifestPath);
const validation = validateManifest(manifest);
if (!validation.ok) throw new Error(validation.errors.join("\n"));
const artifactRoot = path.resolve(args["artifacts-dir"]);
let updated = 0;
for (const artifact of manifest.artifacts) {
  if (artifact.sha256 !== null && artifact.sha256 !== undefined) continue;
  if (artifact.status === "withdrawn" || artifact.kind === "checksum-manifest")
    continue;
  const record = await artifactFileRecord(artifactRoot, artifact);
  artifact.sha256 = record.sha256;
  artifact.sizeBytes = record.sizeBytes;
  artifact.validation ??= { evidence: [] };
  if (!artifact.validation.evidence.includes("sha256-generated"))
    artifact.validation.evidence.push("sha256-generated");
  updated++;
}
const temporary = `${manifestPath}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporary, manifestPath);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Updated ${updated} artifact checksums in ${manifestPath}`);
