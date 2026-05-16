#!/usr/bin/env node
// Updates a release manifest artifact entry with real build-time values.
//
// Usage:
//   node update-release-manifest.mjs \
//     --manifest  packages/os/release/beta-2026-05-16/manifest.json \
//     --artifact  linux-live-iso-amd64 \
//     --sha256    <hex> \
//     --size      <bytes> \
//     --url       https://downloads.elizaos.ai/...
//
// Fields updated on the matched artifact:
//   sha256        — the hex checksum
//   sizeBytes     — file size in bytes (integer)
//   downloadUrl   — canonical download URL
//   status        — set to "available" (was "candidate")
//   validation.evidence — appended with "sha256-generated" if not already present
//
// Exits non-zero when the artifact id is not found.

import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const required = ['manifest', 'artifact'];
const missing = required.filter((k) => !args[k]);
if (missing.length > 0) {
  console.error(`error: missing required arguments: ${missing.map((k) => `--${k}`).join(', ')}`);
  console.error('Usage: node update-release-manifest.mjs --manifest PATH --artifact ID [--sha256 HASH] [--size BYTES] [--url URL]');
  process.exit(1);
}

const manifestPath = args.manifest;
let raw;
try {
  raw = fs.readFileSync(manifestPath, 'utf8');
} catch (err) {
  console.error(`error: cannot read manifest at ${manifestPath}: ${err.message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (err) {
  console.error(`error: manifest is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(manifest.artifacts)) {
  console.error('error: manifest.artifacts is not an array');
  process.exit(1);
}

const artifact = manifest.artifacts.find((a) => a.id === args.artifact);
if (!artifact) {
  console.error(`error: artifact "${args.artifact}" not found in ${manifestPath}`);
  console.error(`available ids: ${manifest.artifacts.map((a) => a.id).join(', ')}`);
  process.exit(1);
}

if (args.sha256) {
  artifact.sha256 = args.sha256;
}
if (args.size !== undefined) {
  const n = Number(args.size);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`error: --size must be a non-negative integer, got: ${args.size}`);
    process.exit(1);
  }
  artifact.sizeBytes = n;
}
if (args.url) {
  artifact.downloadUrl = args.url;
}

artifact.status = 'available';

// Append "sha256-generated" evidence marker if a checksum was provided
// and the marker is not already present.
if (args.sha256) {
  if (!artifact.validation) {
    artifact.validation = { requiredEvidence: [], evidence: [] };
  }
  if (!Array.isArray(artifact.validation.evidence)) {
    artifact.validation.evidence = [];
  }
  if (!artifact.validation.evidence.includes('sha256-generated')) {
    artifact.validation.evidence.push('sha256-generated');
  }
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updated artifact "${args.artifact}" in ${manifestPath}`);
if (args.sha256) console.log(`  sha256:     ${artifact.sha256}`);
if (args.size !== undefined) console.log(`  sizeBytes:  ${artifact.sizeBytes}`);
if (args.url) console.log(`  downloadUrl: ${artifact.downloadUrl}`);
console.log(`  status:     ${artifact.status}`);
