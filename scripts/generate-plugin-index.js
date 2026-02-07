#!/usr/bin/env node
/**
 * Convenience wrapper — delegates to the canonical script inside the
 * milaidy package. Can be run from the monorepo root:
 *
 *   node scripts/generate-plugin-index.js
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, "../packages/milaidy/scripts/generate-plugin-index.js");

await import(target);
