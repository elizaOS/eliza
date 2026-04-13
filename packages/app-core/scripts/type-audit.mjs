#!/usr/bin/env node
/**
 * Type Audit Script
 *
 * Scans the entire codebase for interfaces, types, enums, and type aliases.
 * Produces a report identifying:
 *   1. Name collisions (same name defined in multiple files)
 *   2. Structural overlaps (types sharing all or most keys)
 *
 * Usage:  node scripts/type-audit.mjs [--json]
 * Output: writes to scripts/type-audit-report.md (and optionally .json)
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_MD = path.join(ROOT, "scripts", "type-audit-report.md");
const OUTPUT_JSON = path.join(ROOT, "scripts", "type-audit-report.json");
const JSON_FLAG = process.argv.includes("--json");

// ─── Config ──────────────────────────────────────────────────────────────────

const SCAN_DIRS = ["src", "packages", "apps", "plugins"].map((d) =>
  path.join(ROOT, d),
);

const IGNORE_PATTERNS = [
  /node_modules/,
  /\.next\//,
  /dist\//,
  /build\//,
  /\.vite\//,
  /\.turbo\//,
  /coverage\//,
  /\.test\.(ts|tsx)$/,
  /\.spec\.(ts|tsx)$/,
  /\.e2e\.(ts|tsx)$/,
  /\.stories\.(ts|tsx)$/,
];

// ─── File collection ─────────────────────────────────────────────────────────

function collectFiles(dirs) {
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    walk(dir, files);
  }
  return files;
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|d\.ts)$/.test(entry.name)) {
      const rel = path.relative(ROOT, full);
      if (!IGNORE_PATTERNS.some((p) => p.test(rel))) {
        acc.push(full);
      }
    }
  }
}

// ─── AST extraction ──────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   name: string,
 *   kind: 'interface' | 'type' | 'enum',
 *   file: string,
 *   line: number,
 *   keys: string[],
 *   exported: boolean,
 *   extends: string[],
 *   rawText: string,
 * }} TypeEntry
 */

function extractTypes(filePath) {
  const source = fs.readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  /** @type {TypeEntry[]} */
  const entries = [];
  const rel = path.relative(ROOT, filePath);

  function isExported(node) {
    return (
      node.modifiers?.some(
        (m) =>
          m.kind === ts.SyntaxKind.ExportKeyword ||
          m.kind === ts.SyntaxKind.DeclareKeyword,
      ) ?? false
    );
  }

  function getLineNumber(node) {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return line + 1;
  }

  function nodeText(node) {
    return node.getText(sf);
  }

  function extractMemberKeys(members) {
    if (!members) return [];
    return members
      .map((m) => {
        if (m.name) {
          if (ts.isComputedPropertyName(m.name)) return null;
          return m.name.getText(sf);
        }
        return null;
      })
      .filter(Boolean);
  }

  function extractTypeLiteralKeys(typeNode) {
    if (!typeNode) return [];

    // TypeLiteral  { a: number; b: string }
    if (ts.isTypeLiteralNode(typeNode)) {
      return extractMemberKeys(typeNode.members);
    }

    // Intersection  A & B & { c: number }
    if (ts.isIntersectionTypeNode(typeNode)) {
      return typeNode.types.flatMap((t) => extractTypeLiteralKeys(t));
    }

    // Union  A | B  — we take the intersection-ish keys (all from each branch)
    // Actually for comparison purposes, collect all keys from all branches
    if (ts.isUnionTypeNode(typeNode)) {
      return typeNode.types.flatMap((t) => extractTypeLiteralKeys(t));
    }

    // Parenthesized
    if (ts.isParenthesizedTypeNode(typeNode)) {
      return extractTypeLiteralKeys(typeNode.type);
    }

    return [];
  }

  function visit(node) {
    // Interface
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const ext = (node.heritageClauses ?? []).flatMap((h) =>
        h.types.map((t) => t.expression.getText(sf)),
      );
      entries.push({
        name: node.name.text,
        kind: "interface",
        file: rel,
        line: getLineNumber(node),
        keys: extractMemberKeys(node.members),
        exported: isExported(node),
        extends: ext,
        rawText: nodeText(node).slice(0, 500),
      });
    }

    // Type alias
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const keys = extractTypeLiteralKeys(node.type);
      entries.push({
        name: node.name.text,
        kind: "type",
        file: rel,
        line: getLineNumber(node),
        keys,
        exported: isExported(node),
        extends: [],
        rawText: nodeText(node).slice(0, 500),
      });
    }

    // Enum
    if (ts.isEnumDeclaration(node) && node.name) {
      const keys = node.members.map((m) => m.name.getText(sf));
      entries.push({
        name: node.name.text,
        kind: "enum",
        file: rel,
        line: getLineNumber(node),
        keys,
        exported: isExported(node),
        extends: [],
        rawText: nodeText(node).slice(0, 500),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return entries;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function groupByName(entries) {
  /** @type {Map<string, TypeEntry[]>} */
  const map = new Map();
  for (const e of entries) {
    const list = map.get(e.name) || [];
    list.push(e);
    map.set(e.name, list);
  }
  return map;
}

/**
 * Compare keys of two entries.
 * Returns: 'identical' | 'subset' | 'superset' | 'overlap' | 'disjoint'
 */
function compareKeys(a, b) {
  if (a.keys.length === 0 && b.keys.length === 0) return "no-keys";
  if (a.keys.length === 0 || b.keys.length === 0) return "no-keys";

  const setA = new Set(a.keys);
  const setB = new Set(b.keys);

  const aInB = [...setA].filter((k) => setB.has(k)).length;
  const bInA = [...setB].filter((k) => setA.has(k)).length;

  if (aInB === setA.size && bInA === setB.size) return "identical";
  if (aInB === setA.size) return "subset"; // A ⊆ B
  if (bInA === setB.size) return "superset"; // B ⊆ A

  const overlap = aInB / Math.min(setA.size, setB.size);
  if (overlap >= 0.6) return "overlap";
  return "disjoint";
}

function findStructuralOverlaps(entries) {
  // Only compare entries that have keys
  const withKeys = entries.filter((e) => e.keys.length >= 2);

  /** @type {Array<{a: TypeEntry, b: TypeEntry, relation: string, sharedKeys: string[], aOnly: string[], bOnly: string[]}>} */
  const overlaps = [];

  for (let i = 0; i < withKeys.length; i++) {
    for (let j = i + 1; j < withKeys.length; j++) {
      const a = withKeys[i];
      const b = withKeys[j];

      // Skip if same file and same name (likely same declaration)
      if (a.file === b.file && a.name === b.name) continue;

      const rel = compareKeys(a, b);
      if (rel === "disjoint" || rel === "no-keys") continue;

      const setA = new Set(a.keys);
      const setB = new Set(b.keys);
      const shared = a.keys.filter((k) => setB.has(k));
      const aOnly = a.keys.filter((k) => !setB.has(k));
      const bOnly = b.keys.filter((k) => !setA.has(k));

      overlaps.push({ a, b, relation: rel, sharedKeys: shared, aOnly, bOnly });
    }
  }

  // Sort: identical first, then subset/superset, then overlap
  const order = { identical: 0, subset: 1, superset: 1, overlap: 2 };
  overlaps.sort((x, y) => (order[x.relation] ?? 3) - (order[y.relation] ?? 3));

  return overlaps;
}

// ─── Report generation ───────────────────────────────────────────────────────

function generateReport(entries, nameGroups, structuralOverlaps) {
  const lines = [];
  const ln = (s = "") => lines.push(s);

  ln("# Type Audit Report");
  ln();
  ln(`Generated: ${new Date().toISOString()}`);
  ln();

  // Summary
  const totalInterfaces = entries.filter((e) => e.kind === "interface").length;
  const totalTypes = entries.filter((e) => e.kind === "type").length;
  const totalEnums = entries.filter((e) => e.kind === "enum").length;
  const exportedCount = entries.filter((e) => e.exported).length;

  ln("## Summary");
  ln();
  ln(`| Metric | Count |`);
  ln(`|--------|-------|`);
  ln(`| Total type definitions | ${entries.length} |`);
  ln(`| Interfaces | ${totalInterfaces} |`);
  ln(`| Type aliases | ${totalTypes} |`);
  ln(`| Enums | ${totalEnums} |`);
  ln(`| Exported | ${exportedCount} |`);
  ln(`| Unique names | ${nameGroups.size} |`);
  ln(
    `| Names with duplicates | ${[...nameGroups.values()].filter((g) => g.length > 1).length} |`,
  );
  ln(
    `| Structural overlaps found | ${structuralOverlaps.filter((o) => o.relation === "identical" || o.relation === "subset" || o.relation === "superset").length} (exact/subset) + ${structuralOverlaps.filter((o) => o.relation === "overlap").length} (partial) |`,
  );
  ln();

  // ── Section 1: Name collisions ───────────────────────────────────────────
  ln("---");
  ln();
  ln("## 1. Name Collisions");
  ln();
  ln("Types/interfaces/enums that share the same name across different files.");
  ln();

  const dupes = [...nameGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (dupes.length === 0) {
    ln("*No name collisions found.*");
  } else {
    for (const [name, group] of dupes) {
      const kinds = [...new Set(group.map((e) => e.kind))].join(", ");
      ln(`### \`${name}\` (${kinds}) — ${group.length} definitions`);
      ln();

      for (const entry of group) {
        ln(
          `- **${entry.file}:${entry.line}** (${entry.kind}${entry.exported ? ", exported" : ""})`,
        );
        if (entry.keys.length > 0) {
          ln(`  - Keys: \`${entry.keys.join("`, `")}\``);
        }
        if (entry.extends.length > 0) {
          ln(`  - Extends: \`${entry.extends.join("`, `")}\``);
        }
      }

      // Quick comparison within the group
      if (group.length === 2) {
        const rel = compareKeys(group[0], group[1]);
        if (rel !== "no-keys") {
          ln();
          ln(`  > Key comparison: **${rel}**`);
        }
      } else if (group.length > 2) {
        // Pairwise
        ln();
        ln("  > Pairwise key comparisons:");
        for (let i = 0; i < group.length && i < 6; i++) {
          for (let j = i + 1; j < group.length && j < 6; j++) {
            const rel = compareKeys(group[i], group[j]);
            if (rel !== "no-keys") {
              ln(
                `  > - ${path.basename(group[i].file)}:${group[i].line} vs ${path.basename(group[j].file)}:${group[j].line}: **${rel}**`,
              );
            }
          }
        }
      }
      ln();
    }
  }

  // ── Section 2: Structural overlaps ────────────────────────────────────────
  ln("---");
  ln();
  ln("## 2. Structural Overlaps (Different Names, Similar Keys)");
  ln();
  ln(
    "Types with different names but identical or heavily overlapping key sets.",
  );
  ln();

  const identicals = structuralOverlaps.filter(
    (o) => o.relation === "identical",
  );
  const subsets = structuralOverlaps.filter(
    (o) => o.relation === "subset" || o.relation === "superset",
  );
  const partials = structuralOverlaps.filter((o) => o.relation === "overlap");

  if (identicals.length > 0) {
    ln("### 2a. Identical Key Sets");
    ln();
    for (const o of identicals) {
      ln(
        `- **\`${o.a.name}\`** (${o.a.file}:${o.a.line}) ↔ **\`${o.b.name}\`** (${o.b.file}:${o.b.line})`,
      );
      ln(
        `  - Shared keys (${o.sharedKeys.length}): \`${o.sharedKeys.join("`, `")}\``,
      );
    }
    ln();
  }

  if (subsets.length > 0) {
    ln("### 2b. Subset/Superset Relationships");
    ln();
    for (const o of subsets) {
      const arrow = o.relation === "subset" ? "⊆" : "⊇";
      ln(
        `- **\`${o.a.name}\`** (${o.a.file}:${o.a.line}) ${arrow} **\`${o.b.name}\`** (${o.b.file}:${o.b.line})`,
      );
      ln(
        `  - Shared keys (${o.sharedKeys.length}): \`${o.sharedKeys.join("`, `")}\``,
      );
      if (o.aOnly.length > 0)
        ln(`  - Only in ${o.a.name}: \`${o.aOnly.join("`, `")}\``);
      if (o.bOnly.length > 0)
        ln(`  - Only in ${o.b.name}: \`${o.bOnly.join("`, `")}\``);
    }
    ln();
  }

  if (partials.length > 0) {
    ln("### 2c. Partial Overlaps (≥60% shared keys)");
    ln();
    // Cap at 50 to keep report manageable
    const shown = partials.slice(0, 50);
    for (const o of shown) {
      const pct = Math.round(
        (o.sharedKeys.length / Math.min(o.a.keys.length, o.b.keys.length)) *
          100,
      );
      ln(
        `- **\`${o.a.name}\`** (${o.a.file}:${o.a.line}) ↔ **\`${o.b.name}\`** (${o.b.file}:${o.b.line}) — ${pct}% overlap`,
      );
      ln(
        `  - Shared (${o.sharedKeys.length}): \`${o.sharedKeys.join("`, `")}\``,
      );
      if (o.aOnly.length > 0)
        ln(`  - Only in ${o.a.name}: \`${o.aOnly.join("`, `")}\``);
      if (o.bOnly.length > 0)
        ln(`  - Only in ${o.b.name}: \`${o.bOnly.join("`, `")}\``);
    }
    if (partials.length > 50) {
      ln();
      ln(
        `*... and ${partials.length - 50} more partial overlaps (see JSON output for full list).*`,
      );
    }
    ln();
  }

  if (
    identicals.length === 0 &&
    subsets.length === 0 &&
    partials.length === 0
  ) {
    ln("*No structural overlaps found.*");
    ln();
  }

  // ── Section 3: Consolidation candidates ───────────────────────────────────
  ln("---");
  ln();
  ln("## 3. Consolidation Candidates");
  ln();
  ln("High-confidence candidates for merging into shared types.");
  ln();

  // Name dupes where keys are identical or subset
  const nameConsolidation = dupes.filter(([, group]) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const rel = compareKeys(group[i], group[j]);
        if (rel === "identical" || rel === "subset" || rel === "superset")
          return true;
      }
    }
    return false;
  });

  if (nameConsolidation.length > 0) {
    ln("### 3a. Same Name + Compatible Structure");
    ln();
    for (const [name, group] of nameConsolidation) {
      ln(`- **\`${name}\`** — defined in ${group.length} places:`);
      for (const e of group) {
        ln(`  - ${e.file}:${e.line} (${e.keys.length} keys)`);
      }
    }
    ln();
  }

  // Structural dupes with different names (strong signal)
  if (identicals.length > 0) {
    ln("### 3b. Different Name, Identical Structure");
    ln();
    ln(
      "These types have different names but *exactly the same keys* — strong candidates for unification:",
    );
    ln();
    for (const o of identicals) {
      ln(
        `- \`${o.a.name}\` (${o.a.file}:${o.a.line}) ↔ \`${o.b.name}\` (${o.b.file}:${o.b.line})`,
      );
      ln(`  - Keys: \`${o.sharedKeys.join("`, `")}\``);
    }
    ln();
  }

  // ── Section 4: Full inventory ──────────────────────────────────────────────
  ln("---");
  ln();
  ln("## 4. Full Inventory");
  ln();
  ln(
    `<details><summary>All ${entries.length} type definitions (click to expand)</summary>`,
  );
  ln();
  ln("| Name | Kind | Exported | File | Line | Keys |");
  ln("|------|------|----------|------|------|------|");
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const keys =
      e.keys.length > 5
        ? `${e.keys.slice(0, 5).join(", ")}... (+${e.keys.length - 5})`
        : e.keys.join(", ");
    ln(
      `| ${e.name} | ${e.kind} | ${e.exported ? "yes" : "no"} | ${e.file} | ${e.line} | ${keys} |`,
    );
  }
  ln();
  ln("</details>");

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("Scanning files...");
const files = collectFiles(SCAN_DIRS);
console.log(`Found ${files.length} TypeScript files to scan.`);

console.log("Extracting type definitions...");
/** @type {TypeEntry[]} */
const allEntries = [];
let processed = 0;
for (const file of files) {
  try {
    const entries = extractTypes(file);
    allEntries.push(...entries);
  } catch (_err) {
    // Skip files that can't be parsed
  }
  processed++;
  if (processed % 100 === 0) {
    process.stdout.write(`  ${processed}/${files.length}\r`);
  }
}
console.log(`Extracted ${allEntries.length} type definitions.`);

console.log("Analyzing name collisions...");
const nameGroups = groupByName(allEntries);

console.log("Analyzing structural overlaps (this may take a moment)...");
const structuralOverlaps = findStructuralOverlaps(allEntries);

console.log("Generating report...");
const report = generateReport(allEntries, nameGroups, structuralOverlaps);

fs.writeFileSync(OUTPUT_MD, report, "utf-8");
console.log(`Report written to ${OUTPUT_MD}`);

if (JSON_FLAG) {
  const jsonData = {
    generated: new Date().toISOString(),
    totalEntries: allEntries.length,
    entries: allEntries.map(({ rawText, ...rest }) => rest),
    nameCollisions: Object.fromEntries(
      [...nameGroups.entries()]
        .filter(([, g]) => g.length > 1)
        .map(([name, group]) => [
          name,
          group.map(({ rawText, ...rest }) => rest),
        ]),
    ),
    structuralOverlaps: structuralOverlaps.map((o) => ({
      a: { name: o.a.name, file: o.a.file, line: o.a.line },
      b: { name: o.b.name, file: o.b.file, line: o.b.line },
      relation: o.relation,
      sharedKeys: o.sharedKeys,
      aOnly: o.aOnly,
      bOnly: o.bOnly,
    })),
  };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(jsonData, null, 2), "utf-8");
  console.log(`JSON data written to ${OUTPUT_JSON}`);
}

console.log("Done!");
