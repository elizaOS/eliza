#!/usr/bin/env node
/**
 * Rigorously verify knip "unused file" candidates before deletion.
 *
 * knip's isolated per-package analysis is heavily false-positive (cross-package
 * imports, dynamic `import()`, view registries, entry points loaded by path
 * string in configs/scripts). This re-checks each candidate against the WHOLE
 * repo and only reports files with ZERO references of ANY kind:
 *   - static `from "...basename"` / `import("...basename")` / `require("...basename")`
 *   - bare path strings containing the basename (dynamic loaders, vite/turbo config)
 *   - the package's `exports` map (public subpath API)
 *   - re-export from a sibling/barrel index
 *
 * Input: the knip-results dir (per-package <slug>.txt + the candidate files).
 * Output: high-confidence DEAD (zero refs) vs LIKELY-USED (with the ref found).
 *
 * Usage: node scripts/verify-dead-files.mjs <knip-results-dir>
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const REPO = process.cwd();
const KDIR = process.argv[2];
if (!KDIR || !existsSync(KDIR)) {
  console.error("usage: node scripts/verify-dead-files.mjs <knip-results-dir>");
  process.exit(1);
}

const INFRA = /test|spec|fixture|stori|mock|__e2e__|stub|\.d\.ts|example/i;

// Collect (pkgDir, relFile) candidates from each <slug>.txt
const candidates = [];
for (const txt of readdirSync(KDIR)) {
  if (!txt.endsWith(".txt")) continue;
  const body = readFileSync(join(KDIR, txt), "utf8");
  const pkgDir = (body.match(/^# (\S+)/m) || [])[1];
  if (!pkgDir) continue;
  const lines = body.split("\n");
  let inFiles = false;
  for (const line of lines) {
    if (/^Unused files/.test(line)) { inFiles = true; continue; }
    if (/^Unused (dev)?[dD]ependencies/.test(line)) { inFiles = false; continue; }
    if (!inFiles) continue;
    const m = line.trim().match(/^(src\/\S+\.(tsx?|mts|cts))/);
    if (m && !INFRA.test(m[1])) candidates.push({ pkgDir, rel: m[1] });
  }
}

function grepFixed(literal) {
  // Fixed-string (-F) basename grep — robust (no regex/backtick shell-quoting
  // bugs), conservative (over-matches generic names → fewer false-DEAD).
  try {
    const out = execSync(
      `git grep -lF ${JSON.stringify(literal)} -- packages plugins apps scripts 2>/dev/null || true`,
      { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 },
    );
    return out
      .split("\n")
      .filter((f) => f && !f.includes("/dist/") && !f.includes("node_modules"));
  } catch {
    return [];
  }
}

const dead = [];
const used = [];
for (const { pkgDir, rel } of candidates) {
  const full = `${pkgDir}/${rel}`;
  const base = basename(rel).replace(/\.(tsx?|mts|cts)$/, "");
  // 1. any import/require/dynamic-import or path string referencing the basename
  const refs = grepFixed(base).filter((f) => f !== full);
  // 2. exports map mention (public subpath)
  let exported = false;
  try {
    const pj = JSON.parse(readFileSync(join(REPO, pkgDir, "package.json"), "utf8"));
    const exp = JSON.stringify(pj.exports || {});
    if (exp.includes(`/${base}`) || exp.includes(rel.replace(/^src\//, "dist/").replace(/\.tsx?$/, ""))) exported = true;
  } catch {}
  if (refs.length === 0 && !exported) {
    dead.push(full);
  } else {
    used.push({ full, refs: refs.slice(0, 3), exported });
  }
}

console.log(`\n=== HIGH-CONFIDENCE DEAD (zero refs anywhere, ${dead.length}) ===`);
dead.forEach((d) => console.log("  " + d));
console.log(`\n=== LIKELY-USED (ref found — false positive, ${used.length}) ===`);
used.slice(0, 25).forEach((u) =>
  console.log(`  ${u.full}  ${u.exported ? "[exports]" : "[" + (u.refs[0] || "?") + "]"}`),
);
if (used.length > 25) console.log(`  ... +${used.length - 25} more`);
console.log(`\nsummary: ${candidates.length} non-infra candidates -> ${dead.length} high-confidence dead, ${used.length} likely-used (FP)`);
