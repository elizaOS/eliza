#!/usr/bin/env node
// Generates an elizaOS Android sideload update manifest JSON file.
// Usage: node generate-manifest.mjs --version <v> --version-code <n> --sha256 <hash> --download-url <url> [options]

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

const opts = parseArgs(args);

const version = opts["version"];
const versionCode = opts["version-code"];
const channel = opts["channel"] ?? "stable";
const sha256 = opts["sha256"];
const sizeBytes = opts["size-bytes"];
const downloadUrl = opts["download-url"];
const changelog = opts["changelog"];
const output = opts["output"] ?? "android-update-manifest.json";

const errors = [];

if (!version) errors.push("--version is required");
if (!versionCode) errors.push("--version-code is required");
if (!sha256) errors.push("--sha256 is required");
if (!downloadUrl) errors.push("--download-url is required");

if (!["stable", "beta", "canary"].includes(channel)) {
  errors.push(`--channel must be one of: stable, beta, canary (got: ${channel})`);
}

const parsedVersionCode = parseInt(versionCode, 10);
if (versionCode && (isNaN(parsedVersionCode) || parsedVersionCode <= 0)) {
  errors.push(`--version-code must be a positive integer (got: ${versionCode})`);
}

if (sizeBytes !== undefined) {
  const parsedSize = parseInt(sizeBytes, 10);
  if (isNaN(parsedSize) || parsedSize < 0) {
    errors.push(`--size-bytes must be a non-negative integer (got: ${sizeBytes})`);
  }
}

if (errors.length > 0) {
  for (const err of errors) {
    console.error(`Error: ${err}`);
  }
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

const manifest = {
  schemaVersion: 1,
  channel,
  latestVersion: version,
  versionCode: parsedVersionCode,
  releaseDate: today,
  downloadUrl,
  sha256,
};

if (sizeBytes !== undefined) {
  manifest.sizeBytes = parseInt(sizeBytes, 10);
}

if (changelog !== undefined) {
  manifest.changelog = changelog;
}

const fs = await import("fs");
const json = JSON.stringify(manifest, null, 2) + "\n";
fs.writeFileSync(output, json, "utf8");

console.log(`Manifest written to: ${output}`);
console.log(json);
