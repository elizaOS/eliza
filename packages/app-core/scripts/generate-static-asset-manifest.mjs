#!/usr/bin/env node
/** Supports app-core build, packaging, or development orchestration for generate static asset manifest mjs. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeStaticAssetManifest } from "./lib/static-asset-manifest.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const outputPath = writeStaticAssetManifest(repoRoot);

console.log(
  `static-asset-manifest: wrote ${path.relative(repoRoot, outputPath)}`,
);
