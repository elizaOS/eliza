#!/usr/bin/env node
import { defaultManifestPath, parseArgs, readJson, validateManifest } from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest || defaultManifestPath;
const manifest = await readJson(manifestPath);
const result = validateManifest(manifest, {
  requirePublishableChecksums: Boolean(args["require-publishable-checksums"]),
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
