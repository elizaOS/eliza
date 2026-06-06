#!/usr/bin/env node
// Find candidate duplicate React components in @elizaos/ui.
//
// Walks packages/ui/src for .ts/.tsx files. Extracts:
//   - filename basename (e.g. button)
//   - exported React component identifiers (default + named PascalCase exports)
//
// Groups by:
//   1. EXACT name (case-insensitive) — same component name in multiple files
//   2. PARTIAL name — components whose normalized name is a token-subset of
//      another, or differ only by a common suffix/prefix (Card / CardLite,
//      ChatHeader / ChatHeaderCompact, etc.)
//
// Output is markdown to stdout + JSON report to scripts/duplicate-components-report.json
//
// Usage: bun run scripts/find-duplicate-components.mjs [--min N]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const srcRoot = path.resolve(pkgRoot, "src");

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const minSize = Number(arg("--min", "2")) || 2;
const verbose = args.includes("--verbose");

/** Recursively walk dir, yielding .ts/.tsx files (skip .stories, .test, types/, dist) */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      if (
        (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) &&
        !entry.name.endsWith(".stories.tsx") &&
        !entry.name.endsWith(".stories.ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test.tsx") &&
        !entry.name.endsWith(".spec.ts") &&
        !entry.name.endsWith(".spec.tsx") &&
        !entry.name.endsWith(".d.ts")
      ) {
        yield full;
      }
    }
  }
}

/** Extract component-ish *definitions* (not re-exports). */
function extractExports(src) {
  const names = new Set();
  // export function PascalCase
  for (const m of src.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z]\w+)/g,
  )) {
    names.add(m[1]);
  }
  // export const PascalCase =
  for (const m of src.matchAll(
    /\bexport\s+(?:default\s+)?(?:const|let|var)\s+([A-Z]\w+)\s*(?:[:=])/g,
  )) {
    names.add(m[1]);
  }
  // export class PascalCase
  for (const m of src.matchAll(/\bexport\s+(?:default\s+)?class\s+([A-Z]\w+)/g)) {
    names.add(m[1]);
  }
  // export default IdentifierAlreadyDeclared (where Identifier is defined in this file)
  for (const m of src.matchAll(/\bexport\s+default\s+([A-Z]\w+)\s*;?\s*$/gm)) {
    const id = m[1];
    // Require a local definition (function/const/class) for it to count as a
    // definition rather than a re-export-via-import.
    const localDef = new RegExp(
      `\\b(?:function|const|let|var|class)\\s+${id}\\b`,
    ).test(src);
    if (localDef) names.add(id);
  }
  // NOTE: We deliberately ignore `export { X }` and `export { X } from "..."` —
  // those are re-exports or alias exports, not definitions.
  return [...names];
}

/** Detect whether the file likely contains a component (returns JSX or uses React types). */
function looksLikeComponent(src, names) {
  if (names.length === 0) return false;
  // crude but cheap
  return /\b(jsx|tsx|<\/?[A-Z]\w|React\.FC|React\.Component|React\.forwardRef|forwardRef\s*[<(]|React\.memo|memo\s*\()/i.test(
    src,
  ) || /return\s*\(\s*</.test(src) || /=>\s*</.test(src);
}

/** Normalize component name for partial-match comparison. */
function normalize(name) {
  return name
    .replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)
    .trim()
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const files = [...walk(srcRoot)];
console.error(`Scanned ${files.length} files`);

const byName = new Map(); // lowername -> [{file, name}]
const allComponents = []; // {file, name, tokens}

for (const file of files) {
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const exports = extractExports(src);
  if (!looksLikeComponent(src, exports)) continue;
  for (const name of exports) {
    // Filter out non-component-ish: ALL_CAPS constants, very short names.
    if (name === name.toUpperCase() && name.length > 1) continue;
    if (name.length < 3) continue;
    const tokens = normalize(name);
    const lower = name.toLowerCase();
    if (!byName.has(lower)) byName.set(lower, []);
    byName.get(lower).push({ file: path.relative(pkgRoot, file), name });
    allComponents.push({ file: path.relative(pkgRoot, file), name, tokens });
  }
}

console.error(`Found ${allComponents.length} component-like exports`);

// 1. Exact-name collisions
const exactDupes = [];
for (const [key, entries] of byName) {
  // Dedupe by (file, name) — same export listed twice via `export { X }` and named
  const uniq = Array.from(
    new Map(entries.map((e) => [`${e.file}::${e.name}`, e])).values(),
  );
  if (uniq.length >= minSize) {
    exactDupes.push({ name: key, count: uniq.length, entries: uniq });
  }
}
exactDupes.sort((a, b) => b.count - a.count);

// 2. Partial-name clusters: group components whose token-sets overlap heavily.
// For each unique base name (first token), cluster all components sharing it.
const byFirstToken = new Map();
for (const c of allComponents) {
  if (!c.tokens.length) continue;
  const k = c.tokens[0];
  if (!byFirstToken.has(k)) byFirstToken.set(k, []);
  byFirstToken.get(k).push(c);
}

const partialClusters = [];
for (const [token, comps] of byFirstToken) {
  // Dedupe by file::name
  const uniq = Array.from(
    new Map(comps.map((c) => [`${c.file}::${c.name}`, c])).values(),
  );
  // Require at least 2 *distinct file basenames* — otherwise it's just a barrel re-export.
  const distinctBasenames = new Set(
    uniq.map((c) => path.basename(c.file).replace(/\.[jt]sx?$/, "")),
  );
  if (uniq.length >= minSize && distinctBasenames.size >= 2) {
    partialClusters.push({ token, count: uniq.length, entries: uniq });
  }
}
partialClusters.sort((a, b) => b.count - a.count);

// 3. Suffix-variant detection: For each cluster, flag pairs that are "X" vs "XSomething"
//    where Something looks like a variant marker (Lite, Compact, Mobile, Mini, Small, ...).
const VARIANT_SUFFIXES = [
  "lite",
  "compact",
  "mobile",
  "mini",
  "small",
  "large",
  "v2",
  "v3",
  "new",
  "old",
  "legacy",
  "experimental",
  "alt",
  "simple",
  "basic",
  "extended",
  "redesign",
  "refresh",
  "rewrite",
  "next",
  "card",
  "row",
  "list",
  "grid",
  "tile",
  "page",
  "panel",
  "popover",
  "dialog",
  "header",
  "footer",
  "body",
];
const suffixSiblings = [];
const allNames = new Set(allComponents.map((c) => c.name));
for (const c of allComponents) {
  for (const suf of VARIANT_SUFFIXES) {
    const sufCap = suf.charAt(0).toUpperCase() + suf.slice(1);
    if (c.name.endsWith(sufCap) && c.name.length > sufCap.length) {
      const base = c.name.slice(0, -sufCap.length);
      if (allNames.has(base)) {
        suffixSiblings.push({ base, variant: c.name, file: c.file, suffix: suf });
      }
    }
  }
}

// --- Output -----------------------------------------------------------------
const report = {
  scanned: files.length,
  components: allComponents.length,
  exactDuplicates: exactDupes,
  partialClusters,
  suffixSiblings,
};
const outJson = path.join(here, "duplicate-components-report.json");
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));

const lines = [];
lines.push(`# Duplicate component candidates in @elizaos/ui\n`);
lines.push(`Scanned **${files.length}** files, **${allComponents.length}** component-like exports.\n`);
lines.push(`Report JSON: \`scripts/duplicate-components-report.json\`\n`);

lines.push(`\n## 1. Exact-name duplicates (${exactDupes.length})\n`);
lines.push(`Components exported with the *same name* from multiple files.\n`);
for (const d of exactDupes) {
  lines.push(`\n### \`${d.entries[0].name}\` × ${d.count}`);
  for (const e of d.entries) lines.push(`- ${e.file}`);
}

lines.push(`\n\n## 2. Partial-name clusters (${partialClusters.length})\n`);
lines.push(
  `Components whose first token (lowercased) matches another. Useful for spotting families that share a name root (e.g. \`Chat*\`, \`Setup*\`).\n`,
);
if (!verbose) {
  lines.push(`\n_(Showing top 40 by size; pass --verbose for all.)_\n`);
}
const partialToShow = verbose ? partialClusters : partialClusters.slice(0, 40);
for (const c of partialToShow) {
  lines.push(`\n### \`${c.token}*\` × ${c.count}`);
  for (const e of c.entries) lines.push(`- \`${e.name}\` — ${e.file}`);
}

lines.push(`\n\n## 3. Variant suffix siblings (${suffixSiblings.length})\n`);
lines.push(
  `Components named like \`Foo\` AND \`FooLite/FooCompact/FooMobile/...\` — likely targets for a single component + variant prop.\n`,
);
for (const s of suffixSiblings) {
  lines.push(`- **${s.base}** ↔ **${s.variant}** (suffix: \`${s.suffix}\`) — ${s.file}`);
}

const outMd = path.join(here, "duplicate-components-report.md");
fs.writeFileSync(outMd, lines.join("\n"));

console.log(lines.join("\n"));
console.error(`\nWrote: ${path.relative(pkgRoot, outJson)}`);
console.error(`Wrote: ${path.relative(pkgRoot, outMd)}`);
