#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactFileRecord,
  defaultManifestPath,
  formatCheckEntry,
  parseArgs,
  readJson,
  repoRoot,
  validateManifest,
  writeJson,
} from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest || defaultManifestPath;
const artifactRoot = path.resolve(args["artifact-root"] || path.dirname(manifestPath));
const outputPath = path.resolve(
  args.output || path.join(path.dirname(manifestPath), "SHA256SUMS"),
);
const updateManifest = Boolean(args["update-manifest"]);

const manifest = await readJson(manifestPath);
const validation = validateManifest(manifest);
if (!validation.ok) {
  for (const error of validation.errors) {
    console.error(`error: ${error}`);
  }
  process.exit(1);
}

const records = [];
for (const artifact of manifest.artifacts) {
  if (artifact.kind === "checksum-manifest" || artifact.status === "withdrawn") {
    continue;
  }
  records.push(await artifactFileRecord(artifactRoot, artifact));
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  [
    `# ElizaOS OS release checksums`,
    `# manifest: ${path.relative(repoRoot, manifestPath)}`,
    `# generated: ${new Date().toISOString()}`,
    ...records.map(formatCheckEntry),
    "",
  ].join("\n"),
);

if (updateManifest) {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const artifact of manifest.artifacts) {
    const record = byId.get(artifact.id);
    if (!record) {
      continue;
    }
    artifact.sizeBytes = record.sizeBytes;
    artifact.sha256 = record.sha256;
  }
  await writeJson(manifestPath, manifest);
}

console.log(`Wrote ${records.length} checksum entries to ${outputPath}`);
