#!/usr/bin/env node
/**
 * find-duplicate-symbols.mjs
 *
 * Multi-strategy TypeScript symbol deduplication analysis across packages/
 *
 * Strategies:
 *  s1 – Exact name match (type/interface/enum/function/class appears in 2+ files)
 *  s2 – Fuzzy name match (normalize prefixes/suffixes, compare across packages)
 *  s3 – Structural match (same field-name set on object-like types)
 *  s4 – Zod schema + hand-written type pair (z.infer<typeof X> vs manual type)
 *  s5 – Enum value overlap (same string/number value sets)
 *  s6 – Function signature match (same (paramTypes) => returnType)
 *  s7 – Trivial type aliases (type Foo = Bar with no transformation)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── Configuration ──────────────────────────────────────────────────────────────

const ROOT = new URL("../packages", import.meta.url);
const PACKAGES_DIR = fileURLToPath(ROOT);
const args = process.argv.slice(2);
const includeTests = args.includes("--include-tests");
const packageFilters = args
  .filter((arg) => arg.startsWith("--package="))
  .map((arg) => arg.slice("--package=".length));
const maxResultsArg = args.find((arg) => arg.startsWith("--max-results="));
const maxResults = maxResultsArg
  ? Number.parseInt(maxResultsArg.slice("--max-results=".length), 10)
  : 100;
const RESULT_LIMIT =
  Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 100;

const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "data",
  "dist",
  "dist-mobile",
  "dist-mobile-ios",
  "dist-mobile-ios-jsc",
  "node_modules",
  "test-results",
  "vendor",
]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function walkTs(dir) {
  const results = [];
  if (!existsDir(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(entry) || entry === "__generated__") continue;
        results.push(...walkTs(full));
      } else if (
        SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf("."))) &&
        !entry.endsWith(".d.ts")
      ) {
        results.push(full);
      }
    } catch {
      // skip unreadable
    }
  }
  return results;
}

function walkPackageRoots(dir, relDir = "") {
  const roots = [];
  if (!existsDir(dir)) return roots;
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = relDir ? `${relDir}/${entry}` : entry;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const packageJson = join(full, "package.json");
    const srcDir = join(full, "src");
    if (existsFile(packageJson) && existsDir(srcDir)) {
      roots.push(rel);
      continue;
    }
    roots.push(...walkPackageRoots(full, rel));
  }
  return roots;
}

function existsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function getPkgName(pkgDir) {
  try {
    const pj = JSON.parse(
      readFileSync(join(PACKAGES_DIR, pkgDir, "package.json"), "utf8"),
    );
    return pj.name || pkgDir;
  } catch {
    return pkgDir;
  }
}

function shouldIncludeFile(file) {
  if (includeTests) return true;
  const normalized = file.split("\\").join("/");
  return !(
    /(^|\/)(__tests__|test|tests|fixtures|mocks)(\/|$)/.test(normalized) ||
    /\.(?:test|spec|e2e|live)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)(vitest|playwright|jest)\.config\.[cm]?[jt]s$/.test(normalized)
  );
}

function matchesPackageFilter(pkgDir, pkgName) {
  if (packageFilters.length === 0) return true;
  return packageFilters.some(
    (filter) =>
      pkgDir === filter ||
      pkgDir.startsWith(`${filter}/`) ||
      pkgName === filter ||
      pkgName.includes(filter),
  );
}

// ── File collector ─────────────────────────────────────────────────────────────

const allFiles = []; // { pkg, pkgName, file, relFile, src }
const scanPackages = walkPackageRoots(PACKAGES_DIR).sort();

for (const pkg of scanPackages) {
  const pkgName = getPkgName(pkg);
  if (!matchesPackageFilter(pkg, pkgName)) continue;
  const pkgDir = join(PACKAGES_DIR, pkg);
  const srcDir = join(pkgDir, "src");
  if (!existsDir(srcDir)) continue;
  for (const file of walkTs(srcDir)) {
    if (!shouldIncludeFile(relative(PACKAGES_DIR, file))) continue;
    try {
      const src = readFileSync(file, "utf8");
      allFiles.push({
        pkg: pkgName,
        file,
        relFile: relative(pkgDir, file),
        src,
      });
    } catch {
      // skip
    }
  }
}

// ── Regex patterns ─────────────────────────────────────────────────────────────

// Match exported declarations (single-line capture of head + limited body)
const DECL_PATTERNS = [
  // interface Foo { ... } (multi-line body capture up to first closing brace at col 0)
  {
    kind: "interface",
    re: /^export\s+(?:declare\s+)?interface\s+(\w+)(?:<[^>]*>)?\s*(?:extends[^{]*)?\{/gm,
  },
  // type Foo = ...
  {
    kind: "type",
    re: /^export\s+(?:declare\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/gm,
  },
  // enum Foo { ... }
  {
    kind: "enum",
    re: /^export\s+(?:const\s+)?enum\s+(\w+)\s*\{/gm,
  },
  // class Foo
  {
    kind: "class",
    re: /^export\s+(?:abstract\s+)?(?:declare\s+)?class\s+(\w+)(?:<[^>]*>)?/gm,
  },
  // function Foo / async function Foo / const Foo = (arrow)
  {
    kind: "function",
    re: /^export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/gm,
  },
  {
    kind: "function",
    re: /^export\s+(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\(/gm,
  },
];

// Extract body text for a declaration (heuristic: grab up to 800 chars after the match start)
function extractBody(src, matchIndex, _kind) {
  const snippet = src.slice(matchIndex, matchIndex + 800).replace(/\n/g, " ");
  return snippet.slice(0, 300);
}

// ── Parse all symbols ──────────────────────────────────────────────────────────

// Map: name → [{pkg, file, relFile, kind, body, raw}]
const byName = new Map();

for (const { pkg, file, relFile, src } of allFiles) {
  for (const { kind, re } of DECL_PATTERNS) {
    let m;
    const regex = new RegExp(re.source, re.flags);
    while ((m = regex.exec(src)) !== null) {
      const name = m[1];
      if (!name) continue;
      const body = extractBody(src, m.index, kind);
      if (!byName.has(name)) byName.set(name, []);
      // Avoid duplicate entries for the same file + name + kind
      const existing = byName.get(name);
      if (!existing.some((e) => e.file === file && e.kind === kind)) {
        existing.push({ pkg, file, relFile, kind, body });
      }
    }
  }
}

// ── Strategy 1: Exact name match ───────────────────────────────────────────────

const s1 = [];
for (const [name, locs] of byName) {
  if (locs.length < 2) continue;
  // Only flag if they appear in different files
  const uniqueFiles = new Set(locs.map((l) => l.file));
  if (uniqueFiles.size < 2) continue;

  // Check: is it just a re-export chain? (simple heuristic)
  // If all packages are the same, skip
  const uniquePkgs = new Set(locs.map((l) => l.pkg));

  s1.push({
    name,
    strategy: "s1_exact",
    confidence: uniquePkgs.size > 1 ? "high" : "medium",
    locations: locs.map(({ pkg, relFile, kind, body }) => ({
      pkg,
      file: relFile,
      kind,
      body,
    })),
  });
}

s1.sort((a, b) => b.locations.length - a.locations.length);

// ── Strategy 2: Fuzzy name match ──────────────────────────────────────────────

function normalizeName(name) {
  // Strip leading I prefix before capital
  let n = name.replace(/^I([A-Z])/, "$1");
  // Strip leading T prefix before capital
  n = n.replace(/^T([A-Z])/, "$1");
  // Strip trailing suffixes
  n = n.replace(
    /(Type|Interface|DTO|Config|Request|Response|Params|Options|Data|Props|Info|Entry|Record|Item|Model|Schema)$/,
    "",
  );
  return n.toLowerCase();
}

const byNorm = new Map(); // normalizedName → [{name, pkg, file, relFile, kind}]
for (const [name, locs] of byName) {
  const norm = normalizeName(name);
  if (!byNorm.has(norm)) byNorm.set(norm, []);
  for (const loc of locs) {
    byNorm.get(norm).push({ name, ...loc });
  }
}

const s2 = [];
for (const [norm, entries] of byNorm) {
  // Only interesting when there are multiple distinct original names
  const distinctNames = new Set(entries.map((e) => e.name));
  if (distinctNames.size < 2) continue;
  // Must span multiple packages
  const distinctPkgs = new Set(entries.map((e) => e.pkg));
  if (distinctPkgs.size < 2) continue;

  s2.push({
    normalizedName: norm,
    strategy: "s2_fuzzy",
    confidence: "medium",
    locations: entries.map(({ name, pkg, relFile, kind, body }) => ({
      name,
      pkg,
      file: relFile,
      kind,
      body,
    })),
  });
}

s2.sort((a, b) => b.locations.length - a.locations.length);

// ── Strategy 3: Structural match (field-name sets) ────────────────────────────

// Extract field names from interface/type body
function extractFields(src, matchIndex) {
  // Grab up to 2000 chars after opening brace
  const start = src.indexOf("{", matchIndex);
  if (start === -1) return null;
  let depth = 0;
  let end = start;
  for (let i = start; i < Math.min(src.length, start + 3000); i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(start + 1, end);
  // Extract field names: lines like `  fieldName:` or `  fieldName?:`
  const fields = new Set();
  const fieldRe = /^\s{1,6}(?:readonly\s+)?(\w+)\??:/gm;
  let fm;
  while ((fm = fieldRe.exec(body)) !== null) {
    if (fm[1] && !["constructor", "prototype"].includes(fm[1])) {
      fields.add(fm[1]);
    }
  }
  return fields.size >= 2 ? fields : null;
}

// Collect field sets for interface/type declarations
const fieldSets = []; // {name, pkg, file, relFile, fields}

for (const { pkg, file, relFile, src } of allFiles) {
  for (const { kind, re } of DECL_PATTERNS) {
    if (kind !== "interface" && kind !== "type") continue;
    let m;
    const regex = new RegExp(re.source, re.flags);
    while ((m = regex.exec(src)) !== null) {
      const name = m[1];
      if (!name) continue;
      const fields = extractFields(src, m.index);
      if (fields && fields.size >= 2) {
        fieldSets.push({ name, pkg, file, relFile, fields });
      }
    }
  }
}

// Compare all pairs
const s3 = [];
const s3Seen = new Set();
for (let i = 0; i < fieldSets.length; i++) {
  for (let j = i + 1; j < fieldSets.length; j++) {
    const a = fieldSets[i];
    const b = fieldSets[j];
    if (a.file === b.file) continue;

    const aFields = a.fields;
    const bFields = b.fields;
    if (aFields.size === 0 || bFields.size === 0) continue;

    // Count overlap
    let overlap = 0;
    for (const f of aFields) {
      if (bFields.has(f)) overlap++;
    }

    const jaccard = overlap / (aFields.size + bFields.size - overlap);
    if (jaccard < 0.6 || overlap < 3) continue;

    const key = [a.name, b.name].sort().join("|");
    if (s3Seen.has(key)) continue;
    s3Seen.add(key);

    const isIdentical = jaccard === 1.0;
    const aIsSubsetOfB =
      overlap === aFields.size && bFields.size > aFields.size;
    const bIsSubsetOfA =
      overlap === bFields.size && aFields.size > bFields.size;

    let relationship = "similar";
    if (isIdentical) relationship = "identical";
    else if (aIsSubsetOfB) relationship = `${a.name} extends ${b.name}`;
    else if (bIsSubsetOfA) relationship = `${b.name} extends ${a.name}`;

    s3.push({
      strategy: "s3_structural",
      confidence: isIdentical ? "high" : "medium",
      relationship,
      jaccard: Math.round(jaccard * 100) / 100,
      overlap,
      locations: [
        {
          name: a.name,
          pkg: a.pkg,
          file: a.relFile,
          fields: [...aFields].slice(0, 15),
        },
        {
          name: b.name,
          pkg: b.pkg,
          file: b.relFile,
          fields: [...bFields].slice(0, 15),
        },
      ],
    });
  }
}

s3.sort((a, b) => b.jaccard - a.jaccard);

// ── Strategy 4: Zod schema + hand-written type pairs ─────────────────────────

// Find all z.infer<typeof X> aliases: type Foo = z.infer<typeof X>
const zodAliases = new Map(); // inferred type name → {pkg, file, relFile, schemaName}

for (const { pkg, file, relFile, src } of allFiles) {
  const re = /^export\s+type\s+(\w+)\s*=\s*z\.infer<typeof\s+(\w+)>/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    zodAliases.set(m[1], {
      pkg,
      file,
      relFile,
      schemaName: m[2],
    });
  }
}

const s4 = [];
for (const [zodTypeName, zodInfo] of zodAliases) {
  // Is there a hand-written interface/type with same or similar name?
  for (const [name, locs] of byName) {
    if (name === zodTypeName) continue; // skip self
    if (normalizeName(name) !== normalizeName(zodTypeName)) continue;
    // Has manual definition (not a zod alias)
    const manualLocs = locs.filter((l) => {
      // Check it's not itself a zod alias
      return !l.body.includes("z.infer") && !l.body.includes("z.object");
    });
    if (manualLocs.length === 0) continue;

    s4.push({
      strategy: "s4_zod_manual",
      confidence: "high",
      zodType: {
        name: zodTypeName,
        schemaName: zodInfo.schemaName,
        pkg: zodInfo.pkg,
        file: zodInfo.relFile,
      },
      manualTypes: manualLocs.map(({ pkg, relFile, kind, body }) => ({
        name,
        pkg,
        file: relFile,
        kind,
        body,
      })),
    });
  }
}

// ── Strategy 5: Enum value overlap ────────────────────────────────────────────

// Extract enum values (string literals or numbers)
const enumDefs = []; // {name, pkg, file, relFile, values: Set<string>}

for (const { pkg, file, relFile, src } of allFiles) {
  const enumRe = /^export\s+(?:const\s+)?enum\s+(\w+)\s*\{([^}]*)\}/gm;
  let m;
  while ((m = enumRe.exec(src)) !== null) {
    const name = m[1];
    const body = m[2];
    const values = new Set();
    // Match string values: Foo = "bar"
    const strRe = /=\s*["']([^"']+)["']/g;
    let sv;
    while ((sv = strRe.exec(body)) !== null) values.add(sv[1]);
    // Match numeric or bare values: Foo = 1
    const numRe = /=\s*(\d+)/g;
    let nv;
    while ((nv = numRe.exec(body)) !== null) values.add(`__num__${nv[1]}`);
    // Fallback: identifier keys only
    if (values.size === 0) {
      const keyRe = /^\s*(\w+)\s*[,=\n]/gm;
      let kv;
      while ((kv = keyRe.exec(body)) !== null) values.add(kv[1].toLowerCase());
    }
    if (values.size >= 2) {
      enumDefs.push({ name, pkg, file, relFile, values });
    }
  }
}

const s5 = [];
const s5Seen = new Set();
for (let i = 0; i < enumDefs.length; i++) {
  for (let j = i + 1; j < enumDefs.length; j++) {
    const a = enumDefs[i];
    const b = enumDefs[j];
    if (a.file === b.file) continue;

    let overlap = 0;
    for (const v of a.values) if (b.values.has(v)) overlap++;
    if (overlap === 0) continue;

    const jaccard = overlap / (a.values.size + b.values.size - overlap);
    if (jaccard < 0.7) continue;

    const key = [a.name, b.name].sort().join("|");
    if (s5Seen.has(key)) continue;
    s5Seen.add(key);

    s5.push({
      strategy: "s5_enum_overlap",
      confidence: jaccard >= 0.95 ? "high" : "medium",
      jaccard: Math.round(jaccard * 100) / 100,
      locations: [
        {
          name: a.name,
          pkg: a.pkg,
          file: a.relFile,
          values: [...a.values],
        },
        {
          name: b.name,
          pkg: b.pkg,
          file: b.relFile,
          values: [...b.values],
        },
      ],
    });
  }
}

s5.sort((a, b) => b.jaccard - a.jaccard);

// ── Strategy 6: Function signature match ──────────────────────────────────────

// Extract function parameter types and return type (simplified)
function extractFnSignature(src, matchIndex) {
  // Grab up to 500 chars
  const snippet = src.slice(matchIndex, matchIndex + 500);
  // Try to extract params + return type
  const m = snippet.match(/\(([^)]*)\)\s*(?::\s*([^{;]+))?/);
  if (!m) return null;
  const params = m[1].replace(/\s+/g, " ").trim();
  const ret = (m[2] || "void").replace(/\s+/g, " ").trim();
  if (params.length < 5 && ret === "void") return null; // too simple
  return `(${params}) => ${ret}`;
}

const fnSignatures = []; // {name, pkg, file, relFile, sig}

for (const { pkg, file, relFile, src } of allFiles) {
  const re = /^export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const sig = extractFnSignature(src, m.index);
    if (sig) fnSignatures.push({ name, pkg, file, relFile, sig });
  }
}

// Group by signature
const bySig = new Map();
for (const fn of fnSignatures) {
  if (!bySig.has(fn.sig)) bySig.set(fn.sig, []);
  bySig.get(fn.sig).push(fn);
}

const s6 = [];
for (const [sig, fns] of bySig) {
  if (fns.length < 2) continue;
  const uniqueFiles = new Set(fns.map((f) => f.file));
  if (uniqueFiles.size < 2) continue;
  // Skip trivial signatures
  if (sig.length < 20) continue;

  s6.push({
    strategy: "s6_fn_signature",
    confidence: "medium",
    signature: sig,
    locations: fns.map(({ name, pkg, relFile }) => ({
      name,
      pkg,
      file: relFile,
    })),
  });
}

// ── Strategy 7: Trivial type aliases ─────────────────────────────────────────

const s7 = [];

for (const { pkg, relFile, src } of allFiles) {
  // type Foo = Bar (no generics, no union, no intersection)
  const re = /^export\s+type\s+(\w+)\s*=\s*(\w+)\s*;/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const aliasName = m[1];
    const targetName = m[2];
    if (aliasName === targetName) continue;
    // Is targetName defined somewhere in codebase?
    if (byName.has(targetName)) {
      s7.push({
        strategy: "s7_trivial_alias",
        confidence: "medium",
        alias: { name: aliasName, pkg, file: relFile },
        target: {
          name: targetName,
          locations: (byName.get(targetName) || []).map(
            ({ pkg, relFile, kind }) => ({
              pkg,
              file: relFile,
              kind,
            }),
          ),
        },
      });
    }
  }
}

// ── Output ─────────────────────────────────────────────────────────────────────

const result = {
  meta: {
    scannedFiles: allFiles.length,
    scannedPackages: new Set(allFiles.map((file) => file.pkg)).size,
    discoveredPackages: scanPackages.length,
    uniqueSymbolNames: byName.size,
    generated: new Date().toISOString(),
  },
  strategies: {
    s1: s1.slice(0, RESULT_LIMIT),
    s2: s2.slice(0, RESULT_LIMIT),
    s3: s3.slice(0, RESULT_LIMIT),
    s4: s4.slice(0, RESULT_LIMIT),
    s5: s5.slice(0, RESULT_LIMIT),
    s6: s6.slice(0, RESULT_LIMIT),
    s7: s7.slice(0, RESULT_LIMIT),
  },
  summary: {
    s1_count: s1.length,
    s2_count: s2.length,
    s3_count: s3.length,
    s4_count: s4.length,
    s5_count: s5.length,
    s6_count: s6.length,
    s7_count: s7.length,
  },
};

process.stdout.write(JSON.stringify(result, null, 2));
