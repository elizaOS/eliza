#!/usr/bin/env node
// Cross-platform replacement for a bash `find ... | while read` pipeline.
// For every `*.ts` source file in the current package (excluding dist/ and
// node_modules/), remove the sibling `*.d.ts` and `*.d.ts.map` if present.
// Used by per-package `clean` scripts (plugin-discord, etc.) to evict
// stray declaration files left by older builds that emitted into src/.

import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const PKG_ROOT = process.cwd();
const PRUNE = new Set(["dist", "node_modules", ".turbo", ".git"]);

function walk(dir, hits) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (PRUNE.has(entry.name)) continue;
      walk(path.join(dir, entry.name), hits);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.ts.map"))
      continue;
    hits.push(path.join(dir, entry.name));
  }
}

const tsFiles = [];
walk(PKG_ROOT, tsFiles);

let removed = 0;
for (const ts of tsFiles) {
  const base = ts.slice(0, -3); // strip .ts
  for (const sibling of [`${base}.d.ts`, `${base}.d.ts.map`]) {
    try {
      statSync(sibling);
      unlinkSync(sibling);
      removed += 1;
    } catch {
      // missing file is fine — matches bash `rm -f`.
    }
  }
}

if (removed > 0) {
  console.log(
    `[clean-stray-dts] removed ${removed} stray declaration file(s).`,
  );
}
