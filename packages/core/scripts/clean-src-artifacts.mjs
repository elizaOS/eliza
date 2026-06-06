#!/usr/bin/env node
// Cross-platform replacement for the bash pipeline:
//   find src -type f \( -name '*.js' -o -name '*.js.map' \
//     -o -name '*.d.ts' -o -name '*.d.ts.map' \) \
//     ! -path 'src/types/generated/*' -delete 2>/dev/null || true
//
// Removes emitted artifacts from src/ that older build setups left behind,
// preserving anything under src/types/generated/. No-throw: failures during
// the sweep are swallowed so `clean` stays idempotent (matches the bash
// `|| true` tail).

import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const srcRoot = path.join(pkgRoot, "src");
const preserveRoot = path.join(srcRoot, "types", "generated");

const EXTS = new Set([".js", ".js.map", ".d.ts", ".d.ts.map"]);

function endsWithAny(name) {
  for (const ext of EXTS) if (name.endsWith(ext)) return true;
  return false;
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the preserve root entirely (matches the `! -path 'src/types/generated/*'`).
      if (full === preserveRoot) continue;
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!endsWithAny(entry.name)) continue;
    try {
      unlinkSync(full);
    } catch {
      // Match the bash `2>/dev/null || true` semantics.
    }
  }
}

try {
  statSync(srcRoot);
} catch {
  process.exit(0);
}

walk(srcRoot);
process.exit(0);
