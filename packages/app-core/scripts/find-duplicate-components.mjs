#!/usr/bin/env node
/**
 * find-duplicate-components.mjs
 *
 * Detects duplicate or highly similar component code across packages.
 * Compares files by:
 *   1. Normalized name matching (e.g. ChatMessage vs chat-message)
 *   2. Token-based Jaccard similarity of file contents
 *
 * Usage:
 *   node scripts/find-duplicate-components.mjs [--threshold 0.6] [--dirs dir1 dir2 ...]
 *
 * Defaults compare packages/app-core/src/components and packages/ui/src
 */

import fs from "node:fs";
import path from "node:path";

// Parse args
const args = process.argv.slice(2);
const thresholdIdx = args.indexOf("--threshold");
const THRESHOLD = thresholdIdx >= 0 ? parseFloat(args[thresholdIdx + 1]) : 0.6;
const dirsIdx = args.indexOf("--dirs");
const customDirs = dirsIdx >= 0 ? args.slice(dirsIdx + 1) : null;

const ROOT = new URL("..", import.meta.url).pathname;

const DEFAULT_DIRS = [
  "eliza/packages/app-core/src/components",
  "eliza/packages/app-core/src/hooks",
  "eliza/packages/ui/src/components",
  "eliza/packages/ui/src/hooks",
];

const DIRS = (customDirs ?? DEFAULT_DIRS).map((d) =>
  path.isAbsolute(d) ? d : path.join(ROOT, d),
);

// Collect all .ts/.tsx files recursively (exclude compiled .js, .d.ts, tests, stories)
function collectFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".stories.")
    ) {
      results.push(full);
    }
  }
  return results;
}

// Normalize a component name: FooBar / foo-bar / fooBar → foobar
function normalizeName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.toLowerCase().replace(/[-_]/g, "");
}

// Tokenize source for similarity comparison
// Strips comments, strings, whitespace, and splits on non-word chars
function tokenize(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " STR ")
    .replace(/\s+/g, " ");
  const tokens = stripped.split(/\W+/).filter((t) => t.length > 1);
  return new Set(tokens);
}

// Jaccard similarity between two sets
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

// Load all files
const allFiles = DIRS.flatMap(collectFiles);

if (allFiles.length === 0) {
  console.error("No files found in specified directories.");
  process.exit(1);
}

console.log(
  `Scanning ${allFiles.length} files across ${DIRS.length} dirs...\n`,
);

// Detect if a file is just a re-export shim (only export {...} from ... lines)
function isReExportShim(source) {
  const meaningful = source
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"),
    );
  return (
    meaningful.length <= 6 &&
    meaningful.every((l) => /^export\s*[{*]/.test(l) || /^\/\//.test(l))
  );
}

// Build file info
const MIN_LINES = 8;
const fileInfos = allFiles
  .map((f) => {
    const source = fs.readFileSync(f, "utf8");
    const lines = source.split("\n").length;
    return {
      path: path.relative(ROOT, f),
      name: normalizeName(f),
      tokens: tokenize(source),
      lines,
      isShim: isReExportShim(source),
    };
  })
  .filter((f) => f.lines >= MIN_LINES);

// Find duplicates
const results = [];

for (let i = 0; i < fileInfos.length; i++) {
  for (let j = i + 1; j < fileInfos.length; j++) {
    const a = fileInfos[i];
    const b = fileInfos[j];

    // Skip files from the same directory root
    const aRoot = a.path.split("/").slice(0, 3).join("/");
    const bRoot = b.path.split("/").slice(0, 3).join("/");
    if (aRoot === bRoot) continue;

    const nameSame = a.name === b.name;
    const sim = jaccard(a.tokens, b.tokens);

    if (nameSame || sim >= THRESHOLD) {
      results.push({
        a: a.path,
        b: b.path,
        nameSame,
        similarity: Math.round(sim * 100),
        aLines: a.lines,
        bLines: b.lines,
        aShim: a.isShim,
        bShim: b.isShim,
      });
    }
  }
}

// Sort by similarity descending
results.sort((a, b) => b.similarity - a.similarity);

if (results.length === 0) {
  console.log(
    `No duplicates found above ${Math.round(THRESHOLD * 100)}% similarity threshold.`,
  );
  process.exit(0);
}

// Output
const NAME_MATCHES = results.filter(
  (r) => r.nameSame && r.similarity < THRESHOLD * 100,
);
const SIM_MATCHES = results.filter((r) => r.similarity >= THRESHOLD * 100);

if (SIM_MATCHES.length > 0) {
  console.log(
    `\x1b[1m=== High Similarity Pairs (>= ${Math.round(THRESHOLD * 100)}%) ===\x1b[0m`,
  );
  for (const r of SIM_MATCHES) {
    const nameTag = r.nameSame ? " \x1b[33m[same name]\x1b[0m" : "";
    const shimTag = r.aShim || r.bShim ? " \x1b[2m[re-export shim]\x1b[0m" : "";
    console.log(`\n  \x1b[36m${r.similarity}%\x1b[0m${nameTag}${shimTag}`);
    console.log(`    ${r.a}  (${r.aLines} lines)`);
    console.log(`    ${r.b}  (${r.bLines} lines)`);
  }
}

if (NAME_MATCHES.length > 0) {
  console.log(
    `\n\x1b[1m=== Same Name, Different Content (<${Math.round(THRESHOLD * 100)}% similar) ===\x1b[0m`,
  );
  for (const r of NAME_MATCHES) {
    const shimTag = r.aShim || r.bShim ? " \x1b[2m[re-export shim]\x1b[0m" : "";
    console.log(`\n  \x1b[33m${r.similarity}%\x1b[0m similar${shimTag}`);
    console.log(`    ${r.a}  (${r.aLines} lines)`);
    console.log(`    ${r.b}  (${r.bLines} lines)`);
  }
}

console.log(
  `\n\x1b[2mTotal: ${results.length} pair(s) found. Threshold: ${Math.round(THRESHOLD * 100)}%.\x1b[0m`,
);
console.log(`\x1b[2mRe-run with --threshold 0.4 to lower sensitivity.\x1b[0m`);
