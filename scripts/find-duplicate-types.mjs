#!/usr/bin/env node
/**
 * find-duplicate-types.mjs
 *
 * Scans all packages/PKG/src/**\/ts files (excluding packages/shared/) for
 * top-level type, interface, and enum declarations and groups them by name to
 * find duplicates.
 *
 * Usage:
 *   node scripts/find-duplicate-types.mjs > /tmp/type-duplicates.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(__dirname, "../packages");

// ── Helpers ──────────────────────────────────────────────────────────────────

function walkDir(dir, ext = ".ts") {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".git"
      )
        continue;
      results.push(...walkDir(full, ext));
    } else if (entry.isFile() && full.endsWith(ext) && !full.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Strip generic type parameters: Foo<T, U> → Foo */
function stripGenerics(name) {
  return name.replace(/<[^>]*>/g, "").trim();
}

/** Normalise a type name for fuzzy matching */
function normaliseName(name) {
  return name
    .replace(/^I([A-Z])/, "$1") // strip I-prefix (IFoo → Foo)
    .replace(/Type$/, "") // strip -Type suffix
    .replace(/Dto$/, "") // strip Dto suffix
    .toLowerCase();
}

/** Very light structural normalisation of a body string */
function normaliseBody(body) {
  return body
    .replace(/\/\/[^\n]*/g, "") // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .replace(/\s+/g, " ") // collapse whitespace
    .replace(/;\s*/g, ";") // normalise semicolons
    .trim();
}

/** Compute a rough similarity score [0..1] between two body strings */
function bodySimilarity(a, b) {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  if (shorter.length === 0) return 0;
  // token-based Jaccard similarity
  const tokenise = (s) => new Set(s.match(/\b\w+\b/g) || []);
  const tokA = tokenise(a);
  const tokB = tokenise(b);
  const intersection = [...tokA].filter((t) => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Parser: extract top-level declarations ───────────────────────────────────

/**
 * Very lightweight extractor — does NOT parse the AST. Instead it uses a
 * multi-pass regex strategy that handles:
 *  - type aliases:   export type Foo = ...
 *  - interfaces:     export interface Foo { ... }
 *  - enums:          export enum Foo { ... }
 *  - re-exports:     export { Foo } from '...'  → SKIPPED
 *  - declare X:      export declare type / interface / enum
 *
 * It counts braces/parentheses to capture the full body.
 */
function extractDeclarations(source) {
  const decls = [];

  // Skip re-export lines early (they are not definitions)
  // export { X, Y } from '...'  or  export * from '...'
  // (We'll handle per-match below too)

  // Declaration regex: matches the keyword and name at the start of each declaration
  const DECL_RE =
    /^(?:export\s+)?(?:declare\s+)?(?:(type)\s+(\w+)(?:<[^>]*>)?\s*=|(interface)\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[^{]+)?|(enum)\s+(\w+))/gm;

  let match;
  while ((match = DECL_RE.exec(source)) !== null) {
    const [fullMatch] = match;
    const start = match.index;

    // Determine kind and name
    let kind, name;
    if (match[1] === "type") {
      kind = "type";
      name = match[2];
    } else if (match[3] === "interface") {
      kind = "interface";
      name = match[4];
    } else if (match[5] === "enum") {
      kind = "enum";
      name = match[6];
    } else {
      continue;
    }

    // Find the end of this declaration by scanning from the start
    let body = "";
    const rest = source.slice(start);

    if (kind === "type") {
      // type alias: body ends at first `;` or a blank line (for multi-line unions)
      // We collect up to a balanced close for object types, or a semicolon
      // for primitives/unions.
      const eqIdx = rest.indexOf("=");
      if (eqIdx === -1) continue;
      const afterEq = rest.slice(eqIdx + 1);
      body = extractTypeBody(afterEq);
    } else {
      // interface / enum: body is inside { }
      const braceIdx = rest.indexOf("{");
      if (braceIdx === -1) continue;
      body = extractBracedBody(rest.slice(braceIdx));
    }

    // Skip if body is empty (malformed or just a re-export)
    if (!body.trim()) continue;

    decls.push({ kind, name, body: normaliseBody(body) });
  }

  return decls;
}

/** Extract a type alias body (everything after `=` up to the terminating `;`) */
function extractTypeBody(after) {
  let depth = 0; // track < > for generics and { } for objects
  let i = 0;
  let inString = false;
  let stringChar = "";

  for (; i < after.length; i++) {
    const ch = after[i];

    if (inString) {
      if (ch === stringChar && after[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth < 0) break; // overshot — stop
    } else if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === ";" && depth === 0) {
      return after.slice(0, i);
    }
    // Also stop at a blank line when depth is 0 (handles multiline unions
    // that are not explicitly terminated)
    else if (ch === "\n" && depth === 0) {
      // peek ahead for another newline
      if (after[i + 1] === "\n" || after[i + 1] === "\r") {
        return after.slice(0, i);
      }
    }
  }
  return after.slice(0, i);
}

/** Extract the content of the first balanced { } block */
function extractBracedBody(from) {
  let depth = 0;
  let i = 0;
  let inString = false;
  let stringChar = "";

  for (; i < from.length; i++) {
    const ch = from[i];
    if (inString) {
      if (ch === stringChar && from[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return from.slice(0, i + 1);
    }
  }
  return from.slice(0, i);
}

// ── Main scan ─────────────────────────────────────────────────────────────────

const packages = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "shared")
  .map((e) => e.name);

// Map: normalisedName → [ { pkg, file, name, kind, body } ]
const byNormName = new Map();

// Also track exact names for quicker lookup
const byExactName = new Map();

let fileCount = 0;
let declCount = 0;

for (const pkg of packages) {
  const srcDir = path.join(PACKAGES_DIR, pkg, "src");
  if (!fs.existsSync(srcDir)) continue;

  const files = walkDir(srcDir);
  for (const file of files) {
    // Skip test files
    if (
      file.includes("__tests__") ||
      file.includes(".test.") ||
      file.includes(".spec.")
    )
      continue;

    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    fileCount++;
    const decls = extractDeclarations(source);
    declCount += decls.length;

    for (const decl of decls) {
      const entry = { pkg, file, name: decl.name, kind: decl.kind, body: decl.body };

      // Exact name map
      if (!byExactName.has(decl.name)) byExactName.set(decl.name, []);
      byExactName.get(decl.name).push(entry);

      // Normalised name map
      const norm = normaliseName(decl.name);
      if (!byNormName.has(norm)) byNormName.set(norm, []);
      byNormName.get(norm).push(entry);
    }
  }
}

process.stderr.write(
  `Scanned ${fileCount} files, extracted ${declCount} declarations\n`
);

// ── Build duplicate report ────────────────────────────────────────────────────

const duplicates = [];

// Helper to determine confidence
function determineConfidence(entries) {
  // All must be from different packages (same pkg is not a "duplicate")
  const pkgs = new Set(entries.map((e) => e.pkg));
  if (pkgs.size < 2) return null; // only one package — skip

  // Check exact name match
  const exactNameMatch =
    new Set(entries.map((e) => e.name)).size === 1;

  // Compare bodies pairwise
  const bodies = entries.map((e) => e.body);
  let minSim = 1;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const sim = bodySimilarity(bodies[i], bodies[j]);
      if (sim < minSim) minSim = sim;
    }
  }

  if (exactNameMatch && minSim >= 0.9) return "exact";
  if (exactNameMatch && minSim >= 0.6) return "likely";
  if (exactNameMatch && minSim >= 0.3) return "possible";
  if (!exactNameMatch && minSim >= 0.8) return "likely"; // fuzzy name, very similar body
  if (!exactNameMatch && minSim >= 0.5) return "possible";
  return null;
}

// Process exact name groups first
for (const [name, entries] of byExactName) {
  if (entries.length < 2) continue;
  const pkgs = new Set(entries.map((e) => e.pkg));
  if (pkgs.size < 2) continue;

  const confidence = determineConfidence(entries);
  if (!confidence) continue;

  duplicates.push({
    name,
    confidence,
    locations: entries.map((e) => ({
      pkg: e.pkg,
      file: e.file,
      kind: e.kind,
      body: e.body,
    })),
  });
}

// Process fuzzy name groups (only names that differ)
const processedExact = new Set(byExactName.keys());
for (const [norm, entries] of byNormName) {
  // Only include if there are multiple distinct exact names (fuzzy group)
  const exactNames = new Set(entries.map((e) => e.name));
  if (exactNames.size === 1) continue; // already handled above
  if (entries.length < 2) continue;
  const pkgs = new Set(entries.map((e) => e.pkg));
  if (pkgs.size < 2) continue;

  const confidence = determineConfidence(entries);
  if (!confidence) continue;

  duplicates.push({
    name: `[fuzzy: ${[...exactNames].join(" / ")}]`,
    confidence,
    normalisedName: norm,
    locations: entries.map((e) => ({
      pkg: e.pkg,
      file: e.file,
      kind: e.kind,
      name: e.name,
      body: e.body,
    })),
  });
}

// Sort: exact first, then by name
duplicates.sort((a, b) => {
  const order = { exact: 0, likely: 1, possible: 2 };
  const diff = (order[a.confidence] ?? 3) - (order[b.confidence] ?? 3);
  if (diff !== 0) return diff;
  return a.name.localeCompare(b.name);
});

const report = {
  scannedFiles: fileCount,
  totalDeclarations: declCount,
  duplicateGroups: duplicates.length,
  duplicates,
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
