#!/usr/bin/env node
/**
 * CLI wrapper that writes the static asset manifest JSON via
 * lib/static-asset-manifest.ts and prints the output path.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeStaticAssetManifest } from "./lib/static-asset-manifest.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const outputPath = writeStaticAssetManifest(repoRoot);

console.log(
  `static-asset-manifest: wrote ${path.relative(repoRoot, outputPath)}`,
);
