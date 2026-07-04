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
 *   4. literal-set duplicate     — string-literal unions, `enum`s, and
 *                                   `as const` enum-like objects that share the
 *                                   SAME value set across ≥2 packages, even
 *                                   under different names (#10201). This is the
 *                                   class that surfaced the connector-setup
 *                                   `SetupState` family ("idle"|"configuring"|
 *                                   "paired"|"error") consolidated into
 *                                   `@elizaos/core`.
 *   5. runtime-schema/type match — zod `z.object(...)` and JSON-schema-like
 *                                   `{ type: "object", properties: ... }`
 *                                   objects whose keys match / strongly
 *                                   overlap exported TypeScript object types.
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
// Reviewed baseline of per-class candidate counts (#10201). Drift against
// it is advisory only — the script never fails the build on it (see --check).
const BASELINE_PATH = path.join(
  ROOT,
  "packages",
  "scripts",
  "type-duplication-audit.baseline.json",
);

const args = new Set(process.argv.slice(2));
const SELF_TEST = args.has("--self-test");
const CHECK = args.has("--check");
const UPDATE_BASELINE = args.has("--update-baseline");
const STRICT = args.has("--strict");

// A subset/superset or near-duplicate pair only counts when both sides carry at
// least this many properties — tiny shapes (`{ id }`, `{ ok }`) collide by
// accident and would drown the report in noise.
const MIN_PROPS = 3;
// Jaccard similarity over `name:typeText` property signatures.
const NEAR_DUP_THRESHOLD = 0.6;
// A literal-set (string-union / enum / `as const`) only clusters when it has at
// least this many members — two-member sets (`"asc"|"desc"`, `"on"|"off"`)
// collide by accident across unrelated domains and would drown the report.
const MIN_LITERAL_MEMBERS = 3;
// Runtime-schema/type matching is intentionally conservative: tiny request
// schemas collide constantly, so require a real property bag and strong key
// overlap before surfacing a candidate.
const MIN_SCHEMA_PROPS = 3;
const SCHEMA_TYPE_OVERLAP_THRESHOLD = 0.8;

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
  --self-test        Prove the clustering fires on a synthetic duplicate pair
                     and ignores a synthetic distinct pair, then exit.
  --check            Compare current per-class candidate counts to the saved
                     baseline and print the drift. ADVISORY: exits 0 even when
                     counts grow (unless --strict). Still writes the report.
  --strict           With --check, exit 1 if any class count increased above
                     the baseline. Off by default so local types are never
                     blocked.
  --update-baseline  Rewrite the checked-in baseline to the current counts.
  --help, -h         Show this help.

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

function propertyNameText(name, sourceFile) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(name.text);
  return name.getText(sourceFile);
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression?.(current) ||
    ts.isTypeAssertionExpression?.(current)
  ) {
    current = current.expression;
  }
  return current;
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
    const name = propertyNameText(member.name, member.getSourceFile());
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

// Extract the string-literal member list of a `type X = "a" | "b" | ...` alias.
// Returns null unless EVERY union member is a string literal (a closed string
// domain). A single-literal alias (`type X = "a"`) is also returned; the
// MIN_LITERAL_MEMBERS threshold decides later whether it is interesting.
function stringUnionMembers(node) {
  if (!ts.isTypeAliasDeclaration(node)) return null;
  const literals = [];
  const collect = (typeNode) => {
    if (
      ts.isLiteralTypeNode(typeNode) &&
      ts.isStringLiteral(typeNode.literal)
    ) {
      literals.push(typeNode.literal.text);
      return true;
    }
    return false;
  };
  const t = node.type;
  if (ts.isUnionTypeNode(t)) {
    for (const member of t.types) {
      if (!collect(member)) return null;
    }
  } else if (!collect(t)) {
    return null;
  }
  return literals;
}

// Value set of a TS `enum` (string/number initializers; bare members fall back
// to their declared name).
function enumMemberValues(node) {
  if (!ts.isEnumDeclaration(node)) return null;
  const values = [];
  for (const member of node.members) {
    const init = member.initializer;
    if (init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init))) {
      values.push(String(init.text));
    } else {
      values.push(member.name.getText());
    }
  }
  return values;
}

// Value set of an `as const` object literal whose values are all string/number
// literals — the enum-like pattern used across the repo (SETUP_ERROR_CODES,
// ChannelType, ...). Returns `{ name, values }` or null.
function constEnumLikeMembers(node) {
  if (!ts.isVariableStatement(node)) return null;
  const decls = node.declarationList.declarations;
  if (decls.length !== 1) return null;
  const decl = decls[0];
  if (!decl.name || !ts.isIdentifier(decl.name) || !decl.initializer) {
    return null;
  }
  const init = decl.initializer;
  if (
    !ts.isAsExpression(init) ||
    !ts.isTypeReferenceNode(init.type) ||
    init.type.typeName.getText() !== "const" ||
    !ts.isObjectLiteralExpression(init.expression) ||
    init.expression.properties.length === 0
  ) {
    return null;
  }
  const values = [];
  for (const prop of init.expression.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const v = prop.initializer;
    if (ts.isStringLiteral(v) || ts.isNumericLiteral(v)) {
      values.push(String(v.text));
    } else {
      return null; // not a pure literal map → not enum-like
    }
  }
  return { name: decl.name.getText(), values };
}

function collectZodBindings(sourceFile) {
  const namespaces = new Set();
  const objectFunctions = new Set();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "zod"
    ) {
      continue;
    }

    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) namespaces.add(clause.name.text);

    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "z") namespaces.add(element.name.text);
        if (imported === "object") objectFunctions.add(element.name.text);
      }
    }
  }

  return { namespaces, objectFunctions };
}

function isZodObjectCall(node, zodBindings) {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return zodBindings.objectFunctions.has(expr.text);
  }
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "object" &&
    ts.isIdentifier(expr.expression) &&
    zodBindings.namespaces.has(expr.expression.text)
  );
}

function objectLiteralKeys(node, sourceFile) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const props = new Map();
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) return null;
    if (ts.isPropertyAssignment(prop) && prop.name) {
      props.set(propertyNameText(prop.name, sourceFile), "schema");
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      props.set(prop.name.text, "schema");
    } else {
      return null;
    }
  }
  return props;
}

function literalStringValue(node) {
  const value = unwrapExpression(node);
  return ts.isStringLiteral(value) ? value.text : null;
}

function propertyNamed(objectLiteral, name, sourceFile) {
  return objectLiteral.properties.find(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      prop.name &&
      propertyNameText(prop.name, sourceFile) === name,
  );
}

function jsonSchemaObjectProperties(node, sourceFile) {
  const objectLiteral = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(objectLiteral)) return null;

  const typeProp = propertyNamed(objectLiteral, "type", sourceFile);
  if (!typeProp || literalStringValue(typeProp.initializer) !== "object") {
    return null;
  }

  const propertiesProp = propertyNamed(objectLiteral, "properties", sourceFile);
  if (!propertiesProp) return null;
  return objectLiteralKeys(
    unwrapExpression(propertiesProp.initializer),
    sourceFile,
  );
}

function schemaOwnerName(node, sourceFile) {
  let current = node;
  let parent = node.parent;
  while (parent) {
    if (
      ts.isPropertyAccessExpression(parent) ||
      ts.isCallExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression?.(parent) ||
      ts.isParenthesizedExpression(parent)
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return parent.name.getText(sourceFile);
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
      return propertyNameText(parent.name, sourceFile);
    }
    return null;
  }
  return null;
}

function jsonSchemaOwnerName(node, sourceFile) {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return parent.name.getText(sourceFile);
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return propertyNameText(parent.name, sourceFile);
  }
  if (
    (ts.isAsExpression(parent) || ts.isSatisfiesExpression?.(parent)) &&
    parent.expression === node
  ) {
    return jsonSchemaOwnerName(parent, sourceFile);
  }
  return null;
}

// Stable, order-independent, de-duplicated identity key for a value set.
function literalSetKey(values) {
  return [...new Set(values)].sort().join("|");
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
  const zodBindings = collectZodBindings(sourceFile);

  const declarations = [];
  const weakTypes = [];
  const literalSets = [];
  const runtimeSchemas = [];

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

  function recordLiteralSet(name, setKind, values, node) {
    literalSets.push({
      name,
      kind: setKind,
      file: relPath,
      line: lineOf(node),
      package: packageOf(relPath),
      members: values,
      memberKey: literalSetKey(values),
      memberCount: new Set(values).size,
    });
  }

  function recordRuntimeSchema(name, schemaKind, props, node) {
    if (!name || !props || props.size < MIN_SCHEMA_PROPS) return;
    runtimeSchemas.push({
      name,
      kind: schemaKind,
      file: relPath,
      line: lineOf(node),
      package: packageOf(relPath),
      props: Object.fromEntries(props),
      propCount: props.size,
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

    // Closed literal domains: string-literal unions, `enum`s, and `as const`
    // enum-like maps. Clustered by value set (class 4) regardless of name.
    if (node.name) {
      const stringUnion = stringUnionMembers(node);
      if (stringUnion) {
        recordLiteralSet(
          node.name.getText(sourceFile),
          "string-union",
          stringUnion,
          node,
        );
      }
      const enumValues = enumMemberValues(node);
      if (enumValues) {
        recordLiteralSet(
          node.name.getText(sourceFile),
          "enum",
          enumValues,
          node,
        );
      }
    }
    const constEnum = constEnumLikeMembers(node);
    if (constEnum) {
      recordLiteralSet(constEnum.name, "as-const", constEnum.values, node);
    }

    if (isZodObjectCall(node, zodBindings)) {
      const arg = node.arguments[0];
      const props = arg ? objectLiteralKeys(arg, sourceFile) : null;
      recordRuntimeSchema(
        schemaOwnerName(node, sourceFile),
        "zod-object",
        props,
        node,
      );
    }

    if (ts.isObjectLiteralExpression(node)) {
      const props = jsonSchemaObjectProperties(node, sourceFile);
      recordRuntimeSchema(
        jsonSchemaOwnerName(node, sourceFile),
        "json-schema-object",
        props,
        node,
      );
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
  return { declarations, weakTypes, literalSets, runtimeSchemas };
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
    if (entry.memberKey) set.add(`literalSet:${entry.memberKey}`);
    if (entry.schemaPairKey) set.add(`schemaPair:${entry.schemaPairKey}`);
  }
  return set;
}

// Stable, order-independent key for a reviewed pair of declarations.
function pairKey(a, b) {
  const left = `${a.file}#${a.name}`;
  const right = `${b.file}#${b.name}`;
  return [left, right].sort().join(" <=> ");
}

function schemaTypePairKey(schema, decl) {
  return `schema:${schema.file}#${schema.name} <=> type:${decl.file}#${decl.name}`;
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

// Cluster literal-sets (string-unions / enums / `as const` maps) by their
// VALUE set — two declarations are the same closed domain if they enumerate the
// same values, regardless of name or kind. Only sets with ≥ MIN_LITERAL_MEMBERS
// members spanning ≥2 packages are reported (#10201).
function buildLiteralSetClusters(literalSets, allowlist) {
  const byKey = new Map();
  for (const set of literalSets) {
    if (set.memberCount < MIN_LITERAL_MEMBERS) continue;
    if (!byKey.has(set.memberKey)) byKey.set(set.memberKey, []);
    byKey.get(set.memberKey).push(set);
  }

  const clusters = [];
  for (const [memberKey, sets] of byKey) {
    if (allowlist.has(`literalSet:${memberKey}`)) continue;
    const packages = new Set(sets.map((s) => s.package));
    if (sets.length < 2 || packages.size < 2) continue;

    // Confidence rises with how many independent packages share the domain,
    // saturating at 5 packages (mirrors the same-name cluster scoring).
    const confidence = Math.min(1, (packages.size - 1) / 4);
    clusters.push({
      memberKey,
      members: memberKey.split("|"),
      memberCount: memberKey.split("|").length,
      names: [...new Set(sets.map((s) => s.name))].sort(),
      packageCount: packages.size,
      declarationCount: sets.length,
      confidence: Number(confidence.toFixed(3)),
      locations: sets.map((s) => ({
        name: s.name,
        kind: s.kind,
        file: s.file,
        line: s.line,
      })),
    });
  }
  return clusters.sort(
    (a, b) =>
      b.packageCount - a.packageCount ||
      b.declarationCount - a.declarationCount ||
      a.memberKey.localeCompare(b.memberKey),
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

function buildRuntimeSchemaMatches(runtimeSchemas, declarations, allowlist) {
  const exportedTypes = declarations.filter(
    (d) => d.exported && d.props && d.propCount >= MIN_SCHEMA_PROPS,
  );
  const byKey = new Map();
  for (let i = 0; i < exportedTypes.length; i += 1) {
    for (const key of Object.keys(exportedTypes[i].props)) {
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = [];
        byKey.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  const matches = [];
  for (const schema of runtimeSchemas.filter(
    (s) => s.propCount >= MIN_SCHEMA_PROPS,
  )) {
    const candidateIndices = new Set();
    for (const key of Object.keys(schema.props)) {
      const bucket = byKey.get(key);
      if (!bucket || bucket.length > MAX_BUCKET) continue;
      for (const idx of bucket) candidateIndices.add(idx);
    }

    const schemaKeys = Object.keys(schema.props);
    const schemaKeySet = new Set(schemaKeys);
    for (const idx of candidateIndices) {
      const typeDecl = exportedTypes[idx];
      const pair = schemaTypePairKey(schema, typeDecl);
      if (allowlist.has(`schemaPair:${pair}`)) continue;

      const typeKeys = Object.keys(typeDecl.props);
      const typeKeySet = new Set(typeKeys);
      const shared = schemaKeys.filter((key) => typeKeySet.has(key)).sort();
      if (shared.length < MIN_SCHEMA_PROPS) continue;

      const overlap = jaccard(schemaKeys, typeKeys);
      const exact =
        shared.length === schemaKeys.length &&
        shared.length === typeKeys.length;
      if (!exact && overlap < SCHEMA_TYPE_OVERLAP_THRESHOLD) continue;

      const samePackage = schema.package === typeDecl.package;
      const confidence = exact
        ? samePackage
          ? 0.95
          : 0.9
        : Number((overlap * (samePackage ? 0.95 : 0.9)).toFixed(3));
      const relation = exact
        ? "exact-key-match"
        : schemaKeys.every((key) => typeKeySet.has(key))
          ? "schema-subset-of-type"
          : typeKeys.every((key) => schemaKeySet.has(key))
            ? "type-subset-of-schema"
            : "high-key-overlap";
      const reason =
        relation === "exact-key-match"
          ? "Runtime schema keys exactly match an exported TypeScript object type."
          : `Runtime schema and exported type share ${shared.length} keys with ${Number(overlap.toFixed(3))} Jaccard overlap.`;

      matches.push({
        schemaPairKey: pair,
        relation,
        schema: {
          name: schema.name,
          kind: schema.kind,
          file: schema.file,
          line: schema.line,
          package: schema.package,
          propCount: schema.propCount,
        },
        type: {
          name: typeDecl.name,
          kind: typeDecl.kind,
          file: typeDecl.file,
          line: typeDecl.line,
          package: typeDecl.package,
          propCount: typeDecl.propCount,
        },
        sharedKeys: shared,
        sharedKeyCount: shared.length,
        keyOverlap: Number(overlap.toFixed(3)),
        confidence: Number(confidence.toFixed(3)),
        reason,
        action: "review shared type + runtime validation ownership",
      });
    }
  }

  return matches.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.sharedKeyCount - a.sharedKeyCount ||
      a.schema.file.localeCompare(b.schema.file) ||
      a.type.file.localeCompare(b.type.file),
  );
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
    literalSetClusters,
    runtimeSchemaMatches,
    weakTypeCounts,
  } = report;
  const lines = [];
  lines.push("# Type-duplication candidate report (#10195, extended #10201)");
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
  lines.push(
    `| Literal-set duplicate (≥ ${MIN_LITERAL_MEMBERS} members, multi-package) | ${literalSetClusters.length} |`,
  );
  lines.push(
    `| Runtime schema ↔ exported type (key overlap ≥ ${SCHEMA_TYPE_OVERLAP_THRESHOLD}) | ${runtimeSchemaMatches.length} |`,
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
  lines.push("## Top literal-set duplicate candidates");
  lines.push("");
  lines.push(
    "Closed string/number domains (string-literal unions, `enum`s, `as const` " +
      "maps) that enumerate the **same value set** across ≥2 packages — even " +
      "under different names. Strong consolidation candidates: a shared union " +
      "in `@elizaos/core` removes drift when a new member is added.",
  );
  lines.push("");
  lines.push("| Names | Members | Packages | Decls | Confidence | Locations |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const cluster of literalSetClusters.slice(0, 25)) {
    const names = cluster.names.map((n) => `\`${n}\``).join(", ");
    const members = `\`${cluster.members.join("\\|")}\``;
    const locs = cluster.locations
      .map((l) => `\`${l.file}:${l.line}\` (${l.kind})`)
      .join("<br>");
    lines.push(
      `| ${names} | ${members} | ${cluster.packageCount} | ${cluster.declarationCount} | ${cluster.confidence} | ${locs} |`,
    );
  }
  lines.push("");
  lines.push("## Top runtime schema ↔ exported type candidates");
  lines.push("");
  lines.push(
    'Zod `z.object(...)` schemas and JSON-schema-like `{ type: "object", ' +
      "properties: ... }` declarations whose property keys exactly match or " +
      "strongly overlap exported TypeScript object types. These are review " +
      "candidates for pairing shared DTOs with runtime validation — not proof " +
      "that ownership is identical.",
  );
  lines.push("");
  lines.push(
    "| Runtime schema | Exported type | Shared keys | Key overlap | Confidence | Reason |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const cand of runtimeSchemaMatches.slice(0, 25)) {
    const shared = `\`${cand.sharedKeys.join("\\|")}\``;
    lines.push(
      `| \`${cand.schema.name}\` (${cand.schema.kind}, \`${cand.schema.file}:${cand.schema.line}\`) | ` +
        `\`${cand.type.name}\` (${cand.type.kind}, \`${cand.type.file}:${cand.type.line}\`) | ` +
        `${shared} | ${cand.keyOverlap} | ${cand.confidence} | ${cand.reason} |`,
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
    "3. Record reviewed-but-kept-separate findings in " +
      "`packages/scripts/type-duplication-audit.allowlist.json` with a written " +
      "`reason` so re-runs stay low-noise: `name` suppresses a same-name " +
      "cluster, `pairKey` a subset/near-duplicate pair, `memberKey` a " +
      "literal-set cluster (the `a|b|c` value key from the report), and " +
      "`schemaPairKey` a runtime-schema/type pair.",
  );
  lines.push(
    "4. Triage guidance + the accepted/rejected family log live in " +
      "[`packages/scripts/type-duplication-triage.md`]" +
      "(../../packages/scripts/type-duplication-triage.md).",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ── Advisory baseline (#10201) ────────────────────────────────────────────
// The baseline records the per-class candidate counts after the first
// human-reviewed consolidation so future drift is visible without blocking the
// build. It is intentionally count-only (not a per-finding ratchet): the
// finder is advisory, and many new local types are legitimate.

const COUNT_LABELS = {
  sameName: "same-name multi-package clusters",
  subsets: "subset/superset candidates",
  nearDuplicates: "structural near-duplicates",
  literalSetClusters: "literal-set duplicates",
  runtimeSchemaMatches: "runtime schema ↔ exported type matches",
  weakAsUnknownAs: "weak: as unknown as",
  weakAsAny: "weak: as any",
  weakExplicitAny: "weak: explicit : any",
};

function countsFromReport(report) {
  return {
    sameName: report.sameName.length,
    subsets: report.subsets.length,
    nearDuplicates: report.nearDuplicates.length,
    literalSetClusters: report.literalSetClusters.length,
    runtimeSchemaMatches: report.runtimeSchemaMatches.length,
    weakAsUnknownAs: report.weakTypeCounts.asUnknownAs,
    weakAsAny: report.weakTypeCounts.asAny,
    weakExplicitAny: report.weakTypeCounts.explicitAny,
  };
}

function baselinePayload(report) {
  return {
    schema: "eliza_type_duplication_baseline_v1",
    updatedAt: report.generatedAt,
    thresholds: report.thresholds,
    filesScanned: report.filesScanned,
    counts: countsFromReport(report),
  };
}

function loadBaselineFile() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

// Compare current counts to the baseline. Returns per-metric drift; `increased`
// flags any class that grew (the advisory signal).
function compareBaseline(counts, baseline) {
  const limits = baseline?.counts ?? {};
  const rows = [];
  let increased = 0;
  for (const key of Object.keys(COUNT_LABELS)) {
    const current = counts[key] ?? 0;
    const base = Number.isInteger(limits[key]) ? limits[key] : null;
    const delta = base === null ? null : current - base;
    if (delta !== null && delta > 0) increased += 1;
    rows.push({ key, current, base, delta });
  }
  return { rows, increased };
}

function printBaselineDrift({ rows, increased }) {
  console.log("[type-duplication-audit] drift vs baseline (advisory):");
  for (const row of rows) {
    const label = COUNT_LABELS[row.key];
    if (row.base === null) {
      console.log(`  ? ${label}: ${row.current} (no baseline entry)`);
      continue;
    }
    const arrow = row.delta > 0 ? "▲" : row.delta < 0 ? "▼" : "=";
    const sign = row.delta > 0 ? `+${row.delta}` : String(row.delta);
    console.log(`  ${arrow} ${label}: ${row.current} / ${row.base} (${sign})`);
  }
  if (increased > 0) {
    console.log(
      `[type-duplication-audit] ${increased} class(es) grew above baseline — ` +
        "review new duplicates, then `--update-baseline` once triaged.",
    );
  }
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
  if (alphaBeta?.similarity !== 1) {
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

  // ── Literal-set clustering (class 4) ──────────────────────────────────
  // pkg-a declares the domain as a string-literal union; pkg-b declares the
  // SAME value set as an `enum` (reordered) — they must cluster across kinds.
  // A 2-member set is below MIN_LITERAL_MEMBERS; a single-package set has no
  // peer; both must be ignored.
  const litA = collectFromSource(
    `
      export type StatusA = "idle" | "configuring" | "paired" | "error";
      export type FlagDomain = "on" | "off";
      export type SoloDomain = "x" | "y" | "z";
    `,
    "pkg-a/src/x.ts",
  );
  const litB = collectFromSource(
    `
      export enum StatusB { Configuring = "configuring", Error = "error", Idle = "idle", Paired = "paired" }
      export const FLAGS = { ON: "on", OFF: "off" } as const;
    `,
    "pkg-b/src/y.ts",
  );
  const allSets = [...litA.literalSets, ...litB.literalSets];
  const litClusters = buildLiteralSetClusters(allSets, new Set());
  const STATUS_KEY = "configuring|error|idle|paired";

  const statusCluster = litClusters.find((c) => c.memberKey === STATUS_KEY);
  if (
    statusCluster?.packageCount !== 2 ||
    !statusCluster.names.includes("StatusA") ||
    !statusCluster.names.includes("StatusB")
  ) {
    console.error(
      `[type-duplication-audit] self-test FAILED: cross-kind StatusA(union)/StatusB(enum) literal-set not clustered (got ${JSON.stringify(statusCluster)})`,
    );
    process.exit(1);
  }
  if (litClusters.some((c) => c.memberKey === "off|on")) {
    console.error(
      "[type-duplication-audit] self-test FAILED: 2-member literal-set should be below MIN_LITERAL_MEMBERS",
    );
    process.exit(1);
  }
  if (litClusters.some((c) => c.memberKey === "x|y|z")) {
    console.error(
      "[type-duplication-audit] self-test FAILED: single-package literal-set should not cluster",
    );
    process.exit(1);
  }
  const litSuppressed = buildLiteralSetClusters(
    allSets,
    new Set([`literalSet:${STATUS_KEY}`]),
  );
  if (litSuppressed.some((c) => c.memberKey === STATUS_KEY)) {
    console.error(
      "[type-duplication-audit] self-test FAILED: allowlist memberKey did not suppress literal-set cluster",
    );
    process.exit(1);
  }

  // ── Runtime schema ↔ exported type matching (class 5) ────────────────
  const schemaSample = collectFromSource(
    `
      import { z } from "zod";
      export const UserDtoSchema = z.object({
        id: z.string(),
        name: z.string(),
        active: z.boolean(),
      });
      export interface UserDto {
        id: string;
        name: string;
        active: boolean;
      }
      export const FeatureFlagSchema = {
        type: "object",
        properties: {
          key: { type: "string" },
          enabled: { type: "boolean" },
          owner: { type: "string" },
        },
      } as const;
      export interface FeatureFlag {
        key: string;
        enabled: boolean;
        owner: string;
      }
      export interface Unrelated {
        latitude: number;
        longitude: number;
        altitude: number;
      }
    `,
    "pkg-schema/src/schema.ts",
  );
  const schemaMatches = buildRuntimeSchemaMatches(
    schemaSample.runtimeSchemas,
    schemaSample.declarations,
    new Set(),
  );
  const userSchemaMatch = schemaMatches.find(
    (c) => c.schema.name === "UserDtoSchema" && c.type.name === "UserDto",
  );
  if (userSchemaMatch?.relation !== "exact-key-match") {
    console.error(
      `[type-duplication-audit] self-test FAILED: z.object schema did not match exported type (got ${JSON.stringify(userSchemaMatch)})`,
    );
    process.exit(1);
  }
  const jsonSchemaMatch = schemaMatches.find(
    (c) =>
      c.schema.name === "FeatureFlagSchema" && c.type.name === "FeatureFlag",
  );
  if (jsonSchemaMatch?.relation !== "exact-key-match") {
    console.error(
      `[type-duplication-audit] self-test FAILED: JSON-schema object did not match exported type (got ${JSON.stringify(jsonSchemaMatch)})`,
    );
    process.exit(1);
  }
  if (schemaMatches.some((c) => c.type.name === "Unrelated")) {
    console.error(
      "[type-duplication-audit] self-test FAILED: unrelated exported type should not match runtime schemas",
    );
    process.exit(1);
  }
  const schemaSuppressed = buildRuntimeSchemaMatches(
    schemaSample.runtimeSchemas,
    schemaSample.declarations,
    new Set([`schemaPair:${userSchemaMatch.schemaPairKey}`]),
  );
  if (
    schemaSuppressed.some(
      (c) => c.schemaPairKey === userSchemaMatch.schemaPairKey,
    )
  ) {
    console.error(
      "[type-duplication-audit] self-test FAILED: allowlist schemaPairKey did not suppress schema/type match",
    );
    process.exit(1);
  }

  // ── Advisory baseline drift compare ───────────────────────────────────
  const fakeReport = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    thresholds: {},
    filesScanned: 1,
    sameName: [1, 2],
    subsets: [1],
    nearDuplicates: [],
    literalSetClusters: [1, 2, 3],
    runtimeSchemaMatches: [1, 2],
    weakTypeCounts: { asUnknownAs: 5, asAny: 0, explicitAny: 7 },
  };
  const baseCounts = countsFromReport(fakeReport);
  if (
    baseCounts.sameName !== 2 ||
    baseCounts.literalSetClusters !== 3 ||
    baseCounts.runtimeSchemaMatches !== 2 ||
    baseCounts.weakExplicitAny !== 7
  ) {
    console.error(
      `[type-duplication-audit] self-test FAILED: countsFromReport (got ${JSON.stringify(baseCounts)})`,
    );
    process.exit(1);
  }
  const baseline = baselinePayload(fakeReport);
  if (compareBaseline(baseCounts, baseline).increased !== 0) {
    console.error(
      "[type-duplication-audit] self-test FAILED: identical counts must show 0 increase",
    );
    process.exit(1);
  }
  const grown = compareBaseline({ ...baseCounts, sameName: 5 }, baseline);
  const sameNameRow = grown.rows.find((r) => r.key === "sameName");
  if (grown.increased !== 1 || sameNameRow.delta !== 3) {
    console.error(
      `[type-duplication-audit] self-test FAILED: baseline drift not detected (got ${JSON.stringify(grown)})`,
    );
    process.exit(1);
  }

  console.log(
    "[type-duplication-audit] self-test passed (shape: duplicate + subset fire, distinct + tiny ignored; literal-set: cross-kind clusters, below-threshold + single-package ignored; runtime-schema/type matches fire; allowlist suppresses; weak-types counted; baseline drift compares)",
  );
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

const files = trackedSourceFiles();
const allDeclarations = [];
const allWeakTypes = [];
const allLiteralSets = [];
const allRuntimeSchemas = [];
for (const relPath of files) {
  const sourceText = readFileSync(path.join(ROOT, relPath), "utf8");
  const { declarations, weakTypes, literalSets, runtimeSchemas } =
    collectFromSource(sourceText, relPath);
  allDeclarations.push(...declarations);
  allWeakTypes.push(...weakTypes);
  allLiteralSets.push(...literalSets);
  allRuntimeSchemas.push(...runtimeSchemas);
}

const allowlist = loadAllowlist();
const sameName = buildSameNameClusters(allDeclarations, allowlist);
const { subsets, nearDuplicates } = buildShapeCandidates(
  allDeclarations,
  allowlist,
);
const literalSetClusters = buildLiteralSetClusters(allLiteralSets, allowlist);
const runtimeSchemaMatches = buildRuntimeSchemaMatches(
  allRuntimeSchemas,
  allDeclarations,
  allowlist,
);
const weakTypeCounts = summarizeWeakTypes(allWeakTypes);

const report = {
  schema: "eliza_type_duplication_audit_v1",
  generatedAt: new Date().toISOString(),
  filesScanned: files.length,
  declarationCount: allDeclarations.length,
  thresholds: {
    minProps: MIN_PROPS,
    nearDuplicateJaccard: NEAR_DUP_THRESHOLD,
    minLiteralMembers: MIN_LITERAL_MEMBERS,
    minSchemaProps: MIN_SCHEMA_PROPS,
    schemaTypeKeyOverlap: SCHEMA_TYPE_OVERLAP_THRESHOLD,
  },
  sameName,
  subsets,
  nearDuplicates,
  literalSetClusters,
  runtimeSchemaMatches,
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
  `[type-duplication-audit] literal-set duplicates (≥ ${MIN_LITERAL_MEMBERS} members, multi-package): ${literalSetClusters.length}`,
);
console.log(
  `[type-duplication-audit] runtime schema ↔ exported type matches (key overlap ≥ ${SCHEMA_TYPE_OVERLAP_THRESHOLD}): ${runtimeSchemaMatches.length}`,
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

if (UPDATE_BASELINE) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(baselinePayload(report), null, 2)}\n`,
  );
  console.log(
    `[type-duplication-audit] wrote ${path.relative(ROOT, BASELINE_PATH)}`,
  );
}

if (CHECK) {
  const baseline = loadBaselineFile();
  if (!baseline) {
    console.error(
      `[type-duplication-audit] no baseline at ${path.relative(ROOT, BASELINE_PATH)} — run with --update-baseline first.`,
    );
    process.exit(STRICT ? 1 : 0);
  }
  const drift = compareBaseline(countsFromReport(report), baseline);
  printBaselineDrift(drift);
  // Advisory by default: only --strict turns drift into a non-zero exit, so
  // local types are never blocked (#10201 acceptance: CI/advisory mode).
  if (STRICT && drift.increased > 0) {
    process.exit(1);
  }
}
