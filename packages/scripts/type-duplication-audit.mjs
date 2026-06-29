#!/usr/bin/env node
/**
 * Type-duplication candidate-finder (#10195).
 *
 * This is NOT an automatic refactor and NOT a gate. It emits a ranked,
 * reviewable list of duplicate / near-duplicate type declarations plus a
 * weak-type inventory, so a human can decide what to consolidate, what to share
 * via `@elizaos/core`, and what is legitimately parallel-but-distinct.
 *
 * Companion to `type-safety-ratchet.mjs`: that script gates unsafe casts at a
 * baseline; this one surfaces the structural type duplication the ratchet never
 * looks at. File scope mirrors the ratchet (git ls-files, production `src/`,
 * no `*.d.ts` / tests / build output).
 *
 * Candidate classes (each ranked by a confidence score 0..1):
 *   1. same-name, multi-package  — `interface ApiResponse` declared in N packages.
 *   2. subset/superset           — one type's property-key set ⊆ another's
 *                                   (candidate for `extends` / `Pick` / `Omit`).
 *   3. structural near-duplicate — Jaccard similarity over property
 *                                   name+type-text above NEAR_DUP_THRESHOLD.
 *
 * Weak-type inventory: per-site `as unknown as`, `as any`, explicit `: any`
 * (the actionable weak types). Bare `: unknown` is intentionally NOT flagged —
 * most are legitimate boundary types (#10195).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "../..");
const ALLOWLIST_PATH = path.join(
  ROOT,
  "packages",
  "scripts",
  "type-duplication-audit.allowlist.json",
);
const JSON_OUT_PATH = path.join(ROOT, "reports", "type-duplication.json");
const MARKDOWN_OUT_PATH = path.join(
  ROOT,
  ".github",
  "issue-evidence",
  "10195-type-duplication.md",
);

const args = new Set(process.argv.slice(2));
const SELF_TEST = args.has("--self-test");

// A subset/superset or near-duplicate pair only counts when both sides carry at
// least this many properties — tiny shapes (`{ id }`, `{ ok }`) collide by
// accident and would drown the report in noise.
const MIN_PROPS = 3;
// Jaccard similarity over `name:typeText` property signatures.
const NEAR_DUP_THRESHOLD = 0.6;

const EXCLUDED_SEGMENTS = new Set([
  "__fixtures__",
  "__mocks__",
  "__tests__",
  "fixtures",
  "generated",
  "mock",
  "mocks",
  "test",
  "tests",
]);

function usage() {
  console.log(`Usage: node packages/scripts/type-duplication-audit.mjs [options]

Options:
  --self-test   Prove the clustering fires on a synthetic duplicate pair and
                ignores a synthetic distinct pair, then exit.
  --help, -h    Show this help.

Writes:
  reports/type-duplication.json                       (gitignored, full output)
  .github/issue-evidence/10195-type-duplication.md    (committed summary)
`);
}

if (args.has("--help") || args.has("-h")) {
  usage();
  process.exit(0);
}

function isProductionSourceFile(relPath) {
  if (!/\.(ts|tsx)$/.test(relPath)) return false;
  if (/\.d\.ts$/.test(relPath)) return false;
  if (!relPath.startsWith("src/") && !relPath.includes("/src/")) return false;

  const parts = relPath.split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return false;

  const base = path.basename(relPath);
  if (/\.(test|spec|e2e|stories?|fixture|mock)\.(ts|tsx)$/.test(base)) {
    return false;
  }

  return true;
}

function trackedSourceFiles() {
  const output = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return [...new Set(output.split("\n").filter(Boolean))]
    .filter(isProductionSourceFile)
    .sort();
}

function sourceFileKind(relPath) {
  return relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

// Map a tracked path to its owning workspace package directory (best-effort):
// the path segment immediately before the first `src/` segment, qualified by
// its parent so nested products (`packages/feed/packages/agents`) stay distinct.
function packageOf(relPath) {
  const parts = relPath.split("/");
  const srcIdx = parts.indexOf("src");
  if (srcIdx <= 0) return parts[0] ?? relPath;
  return parts.slice(0, srcIdx).join("/");
}

function normalizeTypeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

// Collect the property signature set of an interface/type-literal declaration.
// Returns null for declarations without a property bag (unions, aliases to
// other names, enums) so they don't enter the shape-comparison passes.
function propertySignatures(node) {
  let members;
  if (ts.isInterfaceDeclaration(node)) {
    members = node.members;
  } else if (
    ts.isTypeAliasDeclaration(node) &&
    ts.isTypeLiteralNode(node.type)
  ) {
    members = node.type.members;
  } else {
    return null;
  }

  const props = new Map();
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = member.name.getText();
    const typeText = member.type
      ? normalizeTypeText(member.type.getText())
      : "any";
    props.set(name, typeText);
  }
  return props;
}

function isExported(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function declKind(node) {
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  return null;
}

// Parse one source file into the type-declaration and weak-type records it
// contributes. `text` is provided directly in self-test mode.
function collectFromSource(sourceText, relPath) {
  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceFileKind(relPath),
  );

  const declarations = [];
  const weakTypes = [];

  function lineOf(node) {
    return (
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1
    );
  }

  function snippet(node) {
    return normalizeTypeText(node.getText(sourceFile)).slice(0, 200);
  }

  function unwrap(node) {
    let current = node;
    while (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    return current;
  }

  // Surrounding named declaration (for weak-type context), if any.
  function enclosingDeclName(node) {
    let current = node.parent;
    while (current) {
      if (
        (ts.isFunctionDeclaration(current) ||
          ts.isMethodDeclaration(current) ||
          ts.isClassDeclaration(current) ||
          ts.isInterfaceDeclaration(current) ||
          ts.isTypeAliasDeclaration(current) ||
          ts.isVariableDeclaration(current) ||
          ts.isPropertyDeclaration(current)) &&
        current.name
      ) {
        return current.name.getText(sourceFile);
      }
      current = current.parent;
    }
    return null;
  }

  function recordWeak(kind, node) {
    weakTypes.push({
      kind,
      file: relPath,
      line: lineOf(node),
      enclosing: enclosingDeclName(node),
      snippet: snippet(node),
    });
  }

  function visit(node) {
    const kind = declKind(node);
    if (kind && node.name) {
      const props = propertySignatures(node);
      declarations.push({
        name: node.name.getText(sourceFile),
        kind,
        exported: isExported(node),
        file: relPath,
        line: lineOf(node),
        package: packageOf(relPath),
        props: props ? Object.fromEntries(props) : null,
        propCount: props ? props.size : 0,
      });
    }

    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        recordWeak("asAny", node);
      }
      const expression = unwrap(node.expression);
      if (
        ts.isAsExpression(expression) &&
        expression.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        recordWeak("asUnknownAs", node);
      }
    }

    // Explicit `: any` type annotation — but NOT the AnyKeyword that is the
    // `.type` of an `as any` cast (counted above) to avoid double counting.
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const parent = node.parent;
      const isAsAnyType =
        parent && ts.isAsExpression(parent) && parent.type === node;
      if (!isAsAnyType) {
        recordWeak("explicitAny", node);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { declarations, weakTypes };
}

function jaccard(aKeys, bKeys) {
  const a = new Set(aKeys);
  const b = new Set(bKeys);
  let inter = 0;
  for (const key of a) {
    if (b.has(key)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function propSignatureKeys(props) {
  // `name:typeText` so two types that share a key but disagree on its type are
  // less similar than two that agree.
  return Object.entries(props).map(([name, type]) => `${name}:${type}`);
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  const data = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  const set = new Set();
  for (const entry of data.entries ?? []) {
    if (entry.pairKey) set.add(entry.pairKey);
    if (entry.name) set.add(`name:${entry.name}`);
  }
  return set;
}

// Stable, order-independent key for a reviewed pair of declarations.
function pairKey(a, b) {
  const left = `${a.file}#${a.name}`;
  const right = `${b.file}#${b.name}`;
  return [left, right].sort().join(" <=> ");
}

function buildSameNameClusters(declarations, allowlist) {
  const byName = new Map();
  for (const decl of declarations) {
    if (!byName.has(decl.name)) byName.set(decl.name, []);
    byName.get(decl.name).push(decl);
  }

  const clusters = [];
  for (const [name, decls] of byName) {
    if (allowlist.has(`name:${name}`)) continue;
    const packages = new Set(decls.map((d) => d.package));
    if (decls.length < 2 || packages.size < 2) continue;

    // Confidence rises with how many independent packages redeclare the name,
    // saturating at 5 packages.
    const confidence = Math.min(1, (packages.size - 1) / 4);
    clusters.push({
      name,
      packageCount: packages.size,
      declarationCount: decls.length,
      confidence: Number(confidence.toFixed(3)),
      locations: decls.map((d) => ({
        file: d.file,
        line: d.line,
        kind: d.kind,
        exported: d.exported,
        propCount: d.propCount,
      })),
    });
  }
  return clusters.sort(
    (a, b) =>
      b.packageCount - a.packageCount ||
      b.declarationCount - a.declarationCount ||
      a.name.localeCompare(b.name),
  );
}

// Blocking: a workspace has tens of thousands of type declarations, so an
// all-pairs O(n²) comparison is intractable. Index every shaped declaration by
// its property keys, then only compare pairs that co-occur in at least one
// (non-ubiquitous) key bucket. A subset/near-duplicate pair shares most of its
// keys, so it is guaranteed to co-occur in some bucket; pairs that share only a
// ubiquitous key (`id`, `name`, …) would score below threshold anyway.
const MAX_BUCKET = 400;

function candidatePairIndices(shaped) {
  const invIndex = new Map();
  for (let i = 0; i < shaped.length; i += 1) {
    for (const key of Object.keys(shaped[i].props)) {
      let bucket = invIndex.get(key);
      if (!bucket) {
        bucket = [];
        invIndex.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  const pairs = new Set();
  for (const bucket of invIndex.values()) {
    if (bucket.length < 2 || bucket.length > MAX_BUCKET) continue;
    for (let x = 0; x < bucket.length; x += 1) {
      for (let y = x + 1; y < bucket.length; y += 1) {
        const i = bucket[x];
        const j = bucket[y];
        pairs.add(i < j ? i * shaped.length + j : j * shaped.length + i);
      }
    }
  }
  return pairs;
}

function buildShapeCandidates(declarations, allowlist) {
  const shaped = declarations.filter(
    (d) => d.props && d.propCount >= MIN_PROPS,
  );
  const subsets = [];
  const nearDuplicates = [];

  const n = shaped.length;
  for (const encoded of candidatePairIndices(shaped)) {
    const i = Math.floor(encoded / n);
    const j = encoded % n;
    {
      const a = shaped[i];
      const b = shaped[j];
      // Skip identical-name same-file (re-parse artifacts) and same declaration.
      if (a.file === b.file && a.name === b.name) continue;

      const key = pairKey(a, b);
      if (allowlist.has(key)) continue;

      const aKeys = Object.keys(a.props);
      const bKeys = Object.keys(b.props);
      const aSet = new Set(aKeys);
      const bSet = new Set(bKeys);

      const aInB = aKeys.every((k) => bSet.has(k));
      const bInA = bKeys.every((k) => aSet.has(k));

      if ((aInB || bInA) && aKeys.length !== bKeys.length) {
        const sub = aInB ? a : b;
        const sup = aInB ? b : a;
        const confidence = Number((sub.propCount / sup.propCount).toFixed(3));
        subsets.push({
          pairKey: key,
          subset: {
            name: sub.name,
            file: sub.file,
            line: sub.line,
            propCount: sub.propCount,
          },
          superset: {
            name: sup.name,
            file: sup.file,
            line: sup.line,
            propCount: sup.propCount,
          },
          sharedKeys: sub.propCount,
          confidence,
          action: "extends / Pick / Omit",
        });
        continue;
      }

      const score = jaccard(
        propSignatureKeys(a.props),
        propSignatureKeys(b.props),
      );
      // Identical shapes (aInB && bInA, equal length) are the strongest
      // near-duplicate signal — keep them here; only strict subset/superset
      // pairs (unequal length) are diverted to the subsets bucket above.
      if (score >= NEAR_DUP_THRESHOLD) {
        nearDuplicates.push({
          pairKey: key,
          a: {
            name: a.name,
            file: a.file,
            line: a.line,
            propCount: a.propCount,
          },
          b: {
            name: b.name,
            file: b.file,
            line: b.line,
            propCount: b.propCount,
          },
          similarity: Number(score.toFixed(3)),
          confidence: Number(score.toFixed(3)),
          action: "merge / share via @elizaos/core",
        });
      }
    }
  }

  subsets.sort(
    (a, b) => b.confidence - a.confidence || b.sharedKeys - a.sharedKeys,
  );
  nearDuplicates.sort((a, b) => b.similarity - a.similarity);
  return { subsets, nearDuplicates };
}

function summarizeWeakTypes(weakTypes) {
  const counts = { asUnknownAs: 0, asAny: 0, explicitAny: 0 };
  for (const item of weakTypes) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  return counts;
}

function renderMarkdown(report) {
  const {
    generatedAt,
    filesScanned,
    declarationCount,
    sameName,
    subsets,
    nearDuplicates,
    weakTypeCounts,
  } = report;
  const lines = [];
  lines.push("# Type-duplication candidate report (#10195)");
  lines.push("");
  lines.push(
    "Generated by `node packages/scripts/type-duplication-audit.mjs` " +
      "(alias `bun run audit:type-duplication`). This is a **human-review " +
      "candidate-finder**, not a gate. Full machine output (gitignored): " +
      "`reports/type-duplication.json`.",
  );
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Production source files scanned: ${filesScanned}`);
  lines.push(`- Type declarations enumerated: ${declarationCount}`);
  lines.push("");
  lines.push("## Candidate counts");
  lines.push("");
  lines.push("| Class | Count |");
  lines.push("| --- | --- |");
  lines.push(`| Same-name, multi-package | ${sameName.length} |`);
  lines.push(`| Subset / superset | ${subsets.length} |`);
  lines.push(
    `| Structural near-duplicate (Jaccard ≥ ${NEAR_DUP_THRESHOLD}) | ${nearDuplicates.length} |`,
  );
  lines.push("");
  lines.push("## Weak-type inventory (actionable casts only)");
  lines.push("");
  lines.push("| Kind | Count |");
  lines.push("| --- | --- |");
  lines.push(`| \`as unknown as\` | ${weakTypeCounts.asUnknownAs} |`);
  lines.push(`| \`as any\` | ${weakTypeCounts.asAny} |`);
  lines.push(`| explicit \`: any\` | ${weakTypeCounts.explicitAny} |`);
  lines.push("");
  lines.push(
    "_Bare `: unknown` is intentionally not inventoried — most are legitimate " +
      "boundary types (#10195)._",
  );
  lines.push("");
  lines.push("## Top same-name, multi-package clusters");
  lines.push("");
  lines.push("| Type | Packages | Declarations | Confidence | Files |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const cluster of sameName.slice(0, 30)) {
    const files = cluster.locations
      .map((l) => `\`${l.file}:${l.line}\``)
      .join("<br>");
    lines.push(
      `| \`${cluster.name}\` | ${cluster.packageCount} | ${cluster.declarationCount} | ${cluster.confidence} | ${files} |`,
    );
  }
  lines.push("");
  lines.push("## Top subset / superset candidates");
  lines.push("");
  lines.push("| Subset | Superset | Shared keys | Confidence | Action |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const cand of subsets.slice(0, 20)) {
    lines.push(
      `| \`${cand.subset.name}\` (\`${cand.subset.file}:${cand.subset.line}\`) | ` +
        `\`${cand.superset.name}\` (\`${cand.superset.file}:${cand.superset.line}\`) | ` +
        `${cand.sharedKeys} | ${cand.confidence} | ${cand.action} |`,
    );
  }
  lines.push("");
  lines.push("## Top structural near-duplicate candidates");
  lines.push("");
  lines.push("| Type A | Type B | Similarity | Action |");
  lines.push("| --- | --- | --- | --- |");
  for (const cand of nearDuplicates.slice(0, 20)) {
    lines.push(
      `| \`${cand.a.name}\` (\`${cand.a.file}:${cand.a.line}\`) | ` +
        `\`${cand.b.name}\` (\`${cand.b.file}:${cand.b.line}\`) | ` +
        `${cand.similarity} | ${cand.action} |`,
    );
  }
  lines.push("");
  lines.push("## Review workflow");
  lines.push("");
  lines.push(
    "1. Triage each cluster: **merge** (genuinely one concept → share via " +
      "`@elizaos/core`), **`extends`/`Pick`/`Omit`** (subset/superset), or " +
      "**rename** (genuinely distinct concepts that collide by name).",
  );
  lines.push(
    "2. Factor high-confidence duplicates by hand — no auto-rewrite. For any " +
      "removed cast, lower the `type-safety-ratchet` baseline.",
  );
  lines.push(
    "3. Record reviewed-but-kept-separate pairs in " +
      "`packages/scripts/type-duplication-audit.allowlist.json` with a written " +
      "`reason` so re-runs stay low-noise.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function runSelfTest() {
  // Synthetic source with a KNOWN duplicate pair (Alpha/Beta share all keys)
  // and a KNOWN distinct pair (Gamma shares nothing with them).
  const sample = `
    export interface Alpha { id: string; name: string; createdAt: number; active: boolean; }
    export interface Beta { id: string; name: string; createdAt: number; active: boolean; }
    export interface Gamma { latitude: number; longitude: number; altitude: number; heading: number; }
    export interface Small { id: string; }
    export interface SubAlpha { id: string; name: string; createdAt: number; }
    const lazyCast = (x) => x as unknown as Alpha;
    const anyCast = (x) => x as any;
    function weak(p: any) { return p; }
  `;
  const { declarations, weakTypes } = collectFromSource(
    sample,
    "pkg/src/self-test.ts",
  );
  const allowlist = new Set();
  const { subsets, nearDuplicates } = buildShapeCandidates(
    declarations,
    allowlist,
  );

  const alphaBeta = nearDuplicates.find(
    (c) =>
      [c.a.name, c.b.name].includes("Alpha") &&
      [c.a.name, c.b.name].includes("Beta"),
  );
  if (!alphaBeta || alphaBeta.similarity !== 1) {
    console.error(
      `[type-duplication-audit] self-test FAILED: identical Alpha/Beta not clustered as near-duplicate (got ${JSON.stringify(alphaBeta)})`,
    );
    process.exit(1);
  }

  // The distinct pair (Gamma vs anything) must NOT appear as a near-duplicate.
  const gammaPaired = nearDuplicates.find(
    (c) => c.a.name === "Gamma" || c.b.name === "Gamma",
  );
  if (gammaPaired) {
    console.error(
      `[type-duplication-audit] self-test FAILED: distinct Gamma was clustered (got ${JSON.stringify(gammaPaired)})`,
    );
    process.exit(1);
  }

  // SubAlpha ⊂ Alpha must surface as a subset candidate.
  const subset = subsets.find(
    (c) => c.subset.name === "SubAlpha" && c.superset.name === "Alpha",
  );
  if (!subset) {
    console.error(
      "[type-duplication-audit] self-test FAILED: SubAlpha ⊂ Alpha not detected as subset",
    );
    process.exit(1);
  }

  // The 1-prop `Small` shape must be ignored (below MIN_PROPS).
  const smallPaired = [...subsets, ...nearDuplicates].some((c) =>
    JSON.stringify(c).includes('"Small"'),
  );
  if (smallPaired) {
    console.error(
      "[type-duplication-audit] self-test FAILED: tiny `Small` shape should be ignored",
    );
    process.exit(1);
  }

  // Allowlist suppression must work.
  const suppressKey = alphaBeta.pairKey;
  const { nearDuplicates: afterAllow } = buildShapeCandidates(
    declarations,
    new Set([suppressKey]),
  );
  if (afterAllow.some((c) => c.pairKey === suppressKey)) {
    console.error(
      "[type-duplication-audit] self-test FAILED: allowlist did not suppress reviewed pair",
    );
    process.exit(1);
  }

  // Weak-type inventory must catch the cast/any sites and nothing spurious.
  const counts = summarizeWeakTypes(weakTypes);
  if (
    counts.asUnknownAs !== 1 ||
    counts.asAny !== 1 ||
    counts.explicitAny !== 1
  ) {
    console.error(
      `[type-duplication-audit] self-test FAILED: weak-type counts off (got ${JSON.stringify(counts)})`,
    );
    process.exit(1);
  }

  console.log(
    "[type-duplication-audit] self-test passed (fires on duplicate + subset, ignores distinct + tiny, allowlist suppresses, weak-types counted)",
  );
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

const files = trackedSourceFiles();
const allDeclarations = [];
const allWeakTypes = [];
for (const relPath of files) {
  const sourceText = readFileSync(path.join(ROOT, relPath), "utf8");
  const { declarations, weakTypes } = collectFromSource(sourceText, relPath);
  allDeclarations.push(...declarations);
  allWeakTypes.push(...weakTypes);
}

const allowlist = loadAllowlist();
const sameName = buildSameNameClusters(allDeclarations, allowlist);
const { subsets, nearDuplicates } = buildShapeCandidates(
  allDeclarations,
  allowlist,
);
const weakTypeCounts = summarizeWeakTypes(allWeakTypes);

const report = {
  schema: "eliza_type_duplication_audit_v1",
  generatedAt: new Date().toISOString(),
  filesScanned: files.length,
  declarationCount: allDeclarations.length,
  thresholds: { minProps: MIN_PROPS, nearDuplicateJaccard: NEAR_DUP_THRESHOLD },
  sameName,
  subsets,
  nearDuplicates,
  weakTypeCounts,
  weakTypes: allWeakTypes,
};

mkdirSync(path.dirname(JSON_OUT_PATH), { recursive: true });
writeFileSync(JSON_OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
mkdirSync(path.dirname(MARKDOWN_OUT_PATH), { recursive: true });
writeFileSync(MARKDOWN_OUT_PATH, renderMarkdown(report));

console.log(
  `[type-duplication-audit] scanned ${files.length} files, ${allDeclarations.length} type declarations`,
);
console.log(
  `[type-duplication-audit] same-name multi-package clusters: ${sameName.length}`,
);
console.log(
  `[type-duplication-audit] subset/superset candidates: ${subsets.length}`,
);
console.log(
  `[type-duplication-audit] structural near-duplicates (Jaccard ≥ ${NEAR_DUP_THRESHOLD}): ${nearDuplicates.length}`,
);
console.log(
  `[type-duplication-audit] weak types — as unknown as: ${weakTypeCounts.asUnknownAs}, as any: ${weakTypeCounts.asAny}, explicit any: ${weakTypeCounts.explicitAny}`,
);
console.log(
  `[type-duplication-audit] wrote ${path.relative(ROOT, JSON_OUT_PATH)}`,
);
console.log(
  `[type-duplication-audit] wrote ${path.relative(ROOT, MARKDOWN_OUT_PATH)}`,
);
