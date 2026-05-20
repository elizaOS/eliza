#!/usr/bin/env bun

/**
 * Duplicate Symbol Finder — Dev tool for identifying code that should be deduplicated
 *
 * Scans all TypeScript source files for functions, classes, interfaces, and type aliases
 * that share names across the codebase. Compares their signatures and outputs a
 * prioritized review queue.
 *
 * Usage:
 *   bun run scripts/find-duplicates.ts
 *   bun run scripts/find-duplicates.ts -- --out dedup-queue.json
 *   bun run scripts/find-duplicates.ts -- --min-score 0.5
 *   bun run scripts/find-duplicates.ts -- --kind function,class
 *   bun run scripts/find-duplicates.ts -- --verbose
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'dedup-review-queue.json' },
    'min-score': { type: 'string', default: '0.3' },
    kind: { type: 'string', default: 'function,class,interface,type' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

if (args['help']) {
  console.log(`
find-duplicates.ts — Identify duplicate symbols across the codebase

Options:
  --out <file>        Output JSON path (default: dedup-review-queue.json)
  --min-score <n>     Minimum similarity score 0–1 to include (default: 0.3)
  --kind <list>       Comma-separated kinds: function,class,interface,type (default: all)
  --verbose           Print every candidate to stdout as well
  --help              Show this message
`);
  process.exit(0);
}

const OUT_FILE = args['out'] as string;
const MIN_SCORE = parseFloat(args['min-score'] as string);
const KINDS = new Set((args['kind'] as string).split(',').map((s) => s.trim()));
const VERBOSE = args['verbose'] as boolean;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SymbolKind = 'function' | 'class' | 'interface' | 'type';

interface SymbolEntry {
  kind: SymbolKind;
  name: string;
  file: string;
  line: number;
  /** Raw parameter string, normalized */
  params: string;
  /** Raw return type string, normalized */
  returnType: string;
  /** Full signature string for display */
  signature: string;
  /** Whether it is exported */
  exported: boolean;
  /** Whether it is async */
  async: boolean;
}

interface DuplicateGroup {
  name: string;
  kind: SymbolKind;
  /** Similarity score 0–1 */
  score: number;
  /** Explanation of the score */
  reason: string;
  entries: Array<{
    file: string;
    line: number;
    signature: string;
    exported: boolean;
  }>;
}

interface ReviewQueue {
  generatedAt: string;
  totalFilesScanned: number;
  totalSymbolsFound: number;
  duplicateGroupCount: number;
  groups: DuplicateGroup[];
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  '.turbo',
  'coverage',
  'build',
  '__generated__',
  'training-data',
  'runs',
  '.git',
]);

function* walkTs(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTs(full);
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing — regex-based extraction
// ---------------------------------------------------------------------------

/** Normalize whitespace, strip comments inline */
function normalize(s: string): string {
  return s
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip leading `export`, `default`, `async`, `abstract`, `declare` keywords */
function _stripModifiers(s: string): string {
  return s
    .replace(
      /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?/,
      ''
    )
    .trim();
}

// Patterns — applied line-by-line (with a small lookahead buffer for multiline sigs)
const PATTERNS: Array<{
  kind: SymbolKind;
  re: RegExp;
  extract: (m: RegExpMatchArray) => {
    name: string;
    params: string;
    returnType: string;
  };
}> = [
  {
    kind: 'function',
    // function foo<T>(a: A, b: B): ReturnType {
    re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{;]+))?/,
    extract: (m) => ({
      name: m[1]!,
      params: normalize(m[2] ?? ''),
      returnType: normalize(m[3] ?? ''),
    }),
  },
  {
    kind: 'function',
    // export const foo = async (a: A): B =>
    // export const foo: (a: A) => B = (a) =>
    re: /^(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?\s*=\s*(?:async\s+)?(?:function\s*)?\(([^)]*)\)\s*(?::\s*([^=>{;]+))?\s*(?:=>|{)/,
    extract: (m) => ({
      name: m[1]!,
      params: normalize(m[2] ?? ''),
      returnType: normalize(m[3] ?? ''),
    }),
  },
  {
    kind: 'class',
    re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    extract: (m) => ({ name: m[1]!, params: '', returnType: '' }),
  },
  {
    kind: 'interface',
    re: /^(?:export\s+)?interface\s+(\w+)/,
    extract: (m) => ({ name: m[1]!, params: '', returnType: '' }),
  },
  {
    kind: 'type',
    re: /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/,
    extract: (m) => ({ name: m[1]!, params: '', returnType: '' }),
  },
];

function parseFile(filePath: string, root: string): SymbolEntry[] {
  let src: string;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const relPath = path.relative(root, filePath);
  const lines = src.split('\n');
  const results: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimStart();

    // skip comments and blank lines
    if (
      !line ||
      line.startsWith('//') ||
      line.startsWith('*') ||
      line.startsWith('/*')
    )
      continue;

    const isExported = /\bexport\b/.test(raw);
    const isAsync = /\basync\b/.test(raw);

    for (const { kind, re, extract } of PATTERNS) {
      if (!KINDS.has(kind)) continue;

      // Concatenate 2 lines to catch signatures split across lines
      const sample = normalize(raw + ' ' + (lines[i + 1] ?? ''));
      const m = sample.match(re);
      if (!m) continue;

      const { name, params, returnType } = extract(m);

      // Skip tiny names that are likely false positives (e.g. `t`, `_`)
      if (name.length < 2) continue;
      // Skip test-only helpers
      if (
        /^(it|test|describe|expect|beforeEach|afterEach|beforeAll|afterAll)$/.test(
          name
        )
      )
        continue;

      const signature = buildSignature(kind, name, params, returnType);

      results.push({
        kind,
        name,
        file: relPath,
        line: i + 1,
        params,
        returnType,
        signature,
        exported: isExported,
        async: isAsync,
      });
      break; // one match per line
    }
  }

  return results;
}

function buildSignature(
  kind: SymbolKind,
  name: string,
  params: string,
  returnType: string
): string {
  if (kind === 'function') {
    return `${name}(${params})${returnType ? `: ${returnType}` : ''}`;
  }
  return `${kind} ${name}`;
}

// ---------------------------------------------------------------------------
// Similarity scoring
// ---------------------------------------------------------------------------

/** Jaccard similarity on token sets */
function tokenSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const tokA = new Set(a.split(/\W+/).filter(Boolean));
  const tokB = new Set(b.split(/\W+/).filter(Boolean));
  let intersection = 0;
  for (const t of tokA) if (tokB.has(t)) intersection++;
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function scorePair(
  a: SymbolEntry,
  b: SymbolEntry
): { score: number; reason: string } {
  if (a.kind !== b.kind) return { score: 0, reason: 'different kinds' };

  if (a.kind === 'function') {
    const paramSim = tokenSimilarity(a.params, b.params);
    const retSim = tokenSimilarity(a.returnType, b.returnType);

    // Exact signature match
    if (a.signature === b.signature) {
      return { score: 1.0, reason: 'identical signatures' };
    }
    // Same params, same return
    if (paramSim > 0.85 && retSim > 0.85) {
      return { score: 0.9, reason: 'nearly identical params and return type' };
    }
    // Same params only
    if (paramSim > 0.7) {
      return {
        score: 0.6 + 0.3 * retSim,
        reason: `similar params (${pct(paramSim)}), return type ${retSim > 0.5 ? 'similar' : 'differs'}`,
      };
    }
    // Same return only
    if (retSim > 0.7) {
      return {
        score: 0.4 + 0.2 * paramSim,
        reason: `similar return type (${pct(retSim)}), params differ`,
      };
    }
    // Both empty (signature-less function match)
    if (!a.params && !b.params && !a.returnType && !b.returnType) {
      return { score: 0.5, reason: 'same name, no signature info extracted' };
    }
    const avg = (paramSim + retSim) / 2;
    return {
      score: avg,
      reason: `partial similarity — params ${pct(paramSim)}, return ${pct(retSim)}`,
    };
  }

  // For classes, interfaces, types — same name = candidate
  return { score: 0.7, reason: `duplicate ${a.kind} name in different files` };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ROOT = '/Users/shawwalters/feed-workspace/feed';

console.log('Scanning TypeScript files...');
const files = [...walkTs(ROOT)];
console.log(`  Found ${files.length} files`);

const allSymbols: SymbolEntry[] = [];
for (const f of files) {
  const syms = parseFile(f, ROOT);
  allSymbols.push(...syms);
}
console.log(`  Extracted ${allSymbols.length} symbol entries`);

// Group by (kind, name)
const byKey = new Map<string, SymbolEntry[]>();
for (const sym of allSymbols) {
  const key = `${sym.kind}:${sym.name}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key)!.push(sym);
}

// Only keep groups with 2+ entries
const groups: DuplicateGroup[] = [];
for (const [, entries] of byKey) {
  if (entries.length < 2) continue;

  // Deduplicate: remove entries from same file+line (can match multiple patterns)
  const unique = entries.filter(
    (e, i, arr) =>
      arr.findIndex((x) => x.file === e.file && x.line === e.line) === i
  );
  if (unique.length < 2) continue;

  // Score: take the best pairwise score across all pairs
  let bestScore = 0;
  let bestReason = '';
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const { score, reason } = scorePair(unique[i]!, unique[j]!);
      if (score > bestScore) {
        bestScore = score;
        bestReason = reason;
      }
    }
  }

  if (bestScore < MIN_SCORE) continue;

  groups.push({
    name: unique[0]!.name,
    kind: unique[0]!.kind,
    score: Math.round(bestScore * 100) / 100,
    reason: bestReason,
    entries: unique.map((e) => ({
      file: e.file,
      line: e.line,
      signature: e.signature,
      exported: e.exported,
    })),
  });
}

// Sort by score desc, then name
groups.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

const queue: ReviewQueue = {
  generatedAt: new Date().toISOString(),
  totalFilesScanned: files.length,
  totalSymbolsFound: allSymbols.length,
  duplicateGroupCount: groups.length,
  groups,
};

// Write JSON
fs.writeFileSync(path.join(ROOT, OUT_FILE), JSON.stringify(queue, null, 2));

// Print summary
console.log(`\nResults:`);
console.log(`  Groups flagged for review: ${groups.length}`);

const byKind = groups.reduce<Record<string, number>>((acc, g) => {
  acc[g.kind] = (acc[g.kind] ?? 0) + 1;
  return acc;
}, {});
for (const [kind, count] of Object.entries(byKind)) {
  console.log(`    ${kind}: ${count}`);
}

// Buckets
const high = groups.filter((g) => g.score >= 0.85);
const med = groups.filter((g) => g.score >= 0.5 && g.score < 0.85);
const low = groups.filter((g) => g.score < 0.5);
console.log(`\n  Score buckets:`);
console.log(`    High (≥0.85, likely duplicate):  ${high.length}`);
console.log(`    Med  (0.5–0.84, worth reviewing): ${med.length}`);
console.log(`    Low  (0.3–0.49, same name only):  ${low.length}`);

if (VERBOSE || high.length <= 20) {
  console.log(
    `\n  Top ${Math.min(20, high.length)} high-confidence duplicates:`
  );
  for (const g of high.slice(0, 20)) {
    console.log(`\n  [${g.score}] ${g.kind} ${g.name} — ${g.reason}`);
    for (const e of g.entries) {
      console.log(`    ${e.file}:${e.line}`);
      console.log(`      ${e.signature}`);
    }
  }
}

console.log(`\nReview queue written to: ${OUT_FILE}`);
console.log(`Open it and search for score >= 0.85 to start deduplication.\n`);
