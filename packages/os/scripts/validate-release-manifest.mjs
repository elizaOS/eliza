#!/usr/bin/env node
// Supports OS release manifests, checksums, and TEE evidence automation.
import {
  defaultManifestPath,
  parseArgs,
  readJson,
  validateManifest,
} from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest || defaultManifestPath;
const manifest = await readJson(manifestPath);
const result = validateManifest(manifest, {
  requirePublishableChecksums: Boolean(args["require-publishable-checksums"]),
  requireDistributionSignatures: Boolean(
    args["require-distribution-signatures"],
  ),
});

for (const warning of result.warnings) {
  console.warn(`warning: ${warning}`);
}

if (!result.ok) {
  for (const error of result.errors) {
    console.error(`error: ${error}`);
  }
  process.exit(1);
}

console.log(`Manifest valid: ${manifestPath}`);
