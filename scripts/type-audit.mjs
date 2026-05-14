#!/usr/bin/env node
/**
 * Type/interface dedupe audit.
 *
 * Scans TypeScript declarations and groups interfaces, type aliases, and enums
 * by name, canonical structure, member signatures, member names, and near
 * overlaps. The markdown report is written for humans; the JSON report is
 * intended for follow-up consolidation work.
 *
 * Usage:
 *   node scripts/type-audit.mjs --json
 *   node scripts/type-audit.mjs --json --production
 *   node scripts/type-audit.mjs --roots=packages/core,plugins/app-lifeops
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_MD = path.join(ROOT, "scripts", "type-audit-report.md");
const OUTPUT_JSON = path.join(ROOT, "scripts", "type-audit-report.json");

const args = process.argv.slice(2);
const JSON_FLAG = args.includes("--json");
const INCLUDE_TESTS =
  !args.includes("--production") && !args.includes("--no-tests");
const NEAR_LIMIT = Number(readArg("--near-limit") ?? 500);
const ROOT_ARGS = readArg("--roots")
  ?.split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const DEFAULT_ROOTS = ["src", "packages", "plugins", "cloud", "apps"];
const SCAN_ROOTS = (ROOT_ARGS?.length ? ROOT_ARGS : DEFAULT_ROOTS)
  .map((entry) => path.resolve(ROOT, entry))
  .filter((entry) => fs.existsSync(entry));

const IGNORED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
]);

const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|__mocks__|test|tests|e2e|fixtures|fixture)(?:\/|$)|\.(?:test|spec|e2e|stories)\.(?:ts|tsx)$/;

function readArg(name) {
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, "/");
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|");
}

function normalizeText(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}[\]():;,|&<>=?+*])\s*/g, "$1")
    .replace(/\s+extends\s+/g, " extends ")
    .replace(/\s+readonly\s+/g, " readonly ")
    .trim();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function collectFiles(roots) {
  const files = [];
  for (const root of roots) {
    walk(root, files);
  }
  files.sort((a, b) => relative(a).localeCompare(relative(b)));
  return files;
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
      continue;
    }

    if (!entry.isFile() || !/\.(?:ts|tsx|d\.ts)$/.test(entry.name)) continue;

    const full = path.join(dir, entry.name);
    const rel = relative(full);
    if (!INCLUDE_TESTS && TEST_FILE_PATTERN.test(rel)) continue;
    acc.push(full);
  }
}

const packageCache = new Map();

function packageForFile(filePath) {
  let dir = path.dirname(filePath);
  while (dir.startsWith(ROOT)) {
    if (packageCache.has(dir)) return packageCache.get(dir);

    const packageJson = path.join(dir, "package.json");
    if (fs.existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        const pkg = {
          name: (parsed.name ?? relative(dir)) || "(root)",
          dir: relative(dir) || ".",
        };
        packageCache.set(dir, pkg);
        return pkg;
      } catch {
        break;
      }
    }

    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }

  return { name: "(root)", dir: "." };
}

function lineAndColumn(sf, node) {
  const position = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: position.line + 1, column: position.character + 1 };
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isExported(node) {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isAmbient(node) {
  return hasModifier(node, ts.SyntaxKind.DeclareKeyword);
}

function typeNodeText(sf, node) {
  return node ? normalizeText(node.getText(sf)) : "unknown";
}

function nameText(sf, name) {
  if (!name) return "";
  if (ts.isComputedPropertyName(name))
    return `[${normalizeText(name.getText(sf))}]`;
  return normalizeText(name.getText(sf).replace(/^["']|["']$/g, ""));
}

function paramSignature(sf, param) {
  const dotDotDot = param.dotDotDotToken ? "..." : "";
  const optional = param.questionToken ? "?" : "";
  const typeText = typeNodeText(sf, param.type);
  return `${dotDotDot}${nameText(sf, param.name)}${optional}:${typeText}`;
}

function memberName(sf, member) {
  if (ts.isIndexSignatureDeclaration(member)) {
    const param = member.parameters[0];
    return `[${nameText(sf, param?.name)}:${typeNodeText(sf, param?.type)}]`;
  }
  if (ts.isCallSignatureDeclaration(member)) return "(call)";
  if (ts.isConstructSignatureDeclaration(member)) return "(construct)";
  return nameText(sf, member.name);
}

function memberSignature(sf, member) {
  const readonly = hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)
    ? "readonly "
    : "";
  const name = memberName(sf, member) || "(member)";
  const optional = member.questionToken ? "?" : "";

  if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
    return `${readonly}${name}${optional}:${typeNodeText(sf, member.type)}`;
  }

  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    const params = member.parameters
      .map((param) => paramSignature(sf, param))
      .join(",");
    return `${name}${optional}(${params}):${typeNodeText(sf, member.type)}`;
  }

  if (ts.isIndexSignatureDeclaration(member)) {
    return `${readonly}${name}:${typeNodeText(sf, member.type)}`;
  }

  if (
    ts.isCallSignatureDeclaration(member) ||
    ts.isConstructSignatureDeclaration(member)
  ) {
    const params = member.parameters
      .map((param) => paramSignature(sf, param))
      .join(",");
    return `${name}(${params}):${typeNodeText(sf, member.type)}`;
  }

  return normalizeText(member.getText(sf));
}

function memberDetails(sf, members) {
  const names = [];
  const signatures = [];

  for (const member of members ?? []) {
    const name = memberName(sf, member);
    if (name) names.push(name);
    signatures.push(memberSignature(sf, member));
  }

  return {
    names: uniqueSorted(names),
    signatures: uniqueSorted(signatures),
  };
}

function typeLiteralMembers(typeNode) {
  if (!typeNode) return [];
  if (ts.isTypeLiteralNode(typeNode)) return [...typeNode.members];
  if (ts.isParenthesizedTypeNode(typeNode))
    return typeLiteralMembers(typeNode.type);
  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.flatMap((inner) => typeLiteralMembers(inner));
  }
  return [];
}

function typeParametersText(sf, node) {
  return (
    node.typeParameters?.map((param) => normalizeText(param.getText(sf))) ?? []
  );
}

function declarationRecord(
  sf,
  filePath,
  node,
  kind,
  name,
  details,
  structureParts,
) {
  const rel = relative(filePath);
  const pkg = packageForFile(filePath);
  const { line, column } = lineAndColumn(sf, node);

  return {
    id: `${rel}:${line}:${name}`,
    name,
    kind,
    file: rel,
    line,
    column,
    packageName: pkg.name,
    packageDir: pkg.dir,
    exported: isExported(node),
    ambient: isAmbient(node),
    typeParameters: typeParametersText(sf, node),
    extends: [],
    memberNames: details.names,
    memberSignatures: details.signatures,
    memberNameKey: details.names.join("|"),
    memberSignatureKey: details.signatures.join("|"),
    structureSignature: normalizeText(structureParts.join("|")),
    snippet: normalizeText(node.getText(sf)).slice(0, 500),
  };
}

function extractDeclarations(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const declarations = [];

  function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const details = memberDetails(sf, node.members);
      const heritage = (node.heritageClauses ?? []).flatMap((clause) =>
        clause.types.map((type) => normalizeText(type.getText(sf))),
      );
      const record = declarationRecord(
        sf,
        filePath,
        node,
        "interface",
        node.name.text,
        details,
        [
          "interface",
          `typeParams:${typeParametersText(sf, node).join(",")}`,
          `extends:${uniqueSorted(heritage).join(",")}`,
          `members:${details.signatures.join(";")}`,
        ],
      );
      record.extends = uniqueSorted(heritage);
      declarations.push(record);
    }

    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const members = typeLiteralMembers(node.type);
      const details = memberDetails(sf, members);
      const typeText = typeNodeText(sf, node.type);
      declarations.push(
        declarationRecord(sf, filePath, node, "type", node.name.text, details, [
          "type",
          `typeParams:${typeParametersText(sf, node).join(",")}`,
          details.signatures.length > 0
            ? `members:${details.signatures.join(";")}`
            : `alias:${typeText}`,
        ]),
      );
    }

    if (ts.isEnumDeclaration(node) && node.name) {
      const memberNames = node.members.map((member) =>
        nameText(sf, member.name),
      );
      const memberSignatures = node.members.map((member) => {
        const initializer = member.initializer
          ? `=${normalizeText(member.initializer.getText(sf))}`
          : "";
        return `${nameText(sf, member.name)}${initializer}`;
      });
      declarations.push(
        declarationRecord(
          sf,
          filePath,
          node,
          "enum",
          node.name.text,
          {
            names: uniqueSorted(memberNames),
            signatures: uniqueSorted(memberSignatures),
          },
          ["enum", `members:${uniqueSorted(memberSignatures).join(";")}`],
        ),
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return declarations;
}

function groupBy(entries, keyFn) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyFn(entry);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function declarationRef(entry) {
  return {
    name: entry.name,
    kind: entry.kind,
    file: entry.file,
    line: entry.line,
    packageName: entry.packageName,
    exported: entry.exported,
    memberNames: entry.memberNames,
    memberSignatures: entry.memberSignatures,
    extends: entry.extends,
  };
}

function serializableGroups(groups, extra = () => ({})) {
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      count: group.length,
      names: uniqueSorted(group.map((entry) => entry.name)),
      packages: uniqueSorted(group.map((entry) => entry.packageName)),
      files: uniqueSorted(group.map((entry) => entry.file)),
      ...extra(key, group),
      declarations: group.map(declarationRef),
    }))
    .sort((a, b) => {
      const byCount = b.count - a.count;
      if (byCount !== 0) return byCount;
      return a.key.localeCompare(b.key);
    });
}

function analyze(entries) {
  const byName = groupBy(entries, (entry) => entry.name);
  const byNameAndStructure = groupBy(
    entries,
    (entry) => `${entry.name}|${entry.structureSignature}`,
  );
  const byStructure = groupBy(entries, (entry) => entry.structureSignature);
  const byMemberSignature = groupBy(entries, (entry) =>
    entry.memberSignatures.length ? entry.memberSignatureKey : "",
  );
  const byMemberNames = groupBy(entries, (entry) =>
    entry.memberNames.length >= 2 ? entry.memberNameKey : "",
  );

  const nameCollisions = serializableGroups(byName);
  const sameNameSameStructure = serializableGroups(
    byNameAndStructure,
    (_key, group) => ({
      name: group[0].name,
      structureSignature: group[0].structureSignature,
    }),
  );
  const sameStructure = serializableGroups(byStructure, (_key, group) => ({
    structureSignature: group[0].structureSignature,
  }));
  const differentNameSameStructure = sameStructure.filter(
    (group) => group.names.length > 1,
  );
  const sameMemberSignature = serializableGroups(
    byMemberSignature,
    (_key, group) => ({ memberSignatures: group[0].memberSignatures }),
  );
  const differentNameSameMemberSignature = sameMemberSignature.filter(
    (group) => group.names.length > 1,
  );
  const sameMemberNames = serializableGroups(byMemberNames, (_key, group) => ({
    memberNames: group[0].memberNames,
  }));
  const differentNameSameMemberNames = sameMemberNames.filter(
    (group) => group.names.length > 1,
  );

  return {
    nameCollisions,
    sameNameSameStructure,
    differentNameSameStructure,
    sameMemberSignature,
    differentNameSameMemberSignature,
    sameMemberNames,
    differentNameSameMemberNames,
    nearOverlaps: findNearOverlaps(entries, NEAR_LIMIT),
  };
}

function findNearOverlaps(entries, limit) {
  const candidates = entries
    .map((entry, index) => ({ entry, index, names: entry.memberNames }))
    .filter(({ names }) => names.length >= 2);
  const byMemberName = new Map();

  for (const candidate of candidates) {
    for (const name of candidate.names) {
      const list = byMemberName.get(name) ?? [];
      list.push(candidate.index);
      byMemberName.set(name, list);
    }
  }

  const pairCounts = new Map();
  const indexToEntry = new Map(
    candidates.map(({ entry, index }) => [index, entry]),
  );

  for (const indexes of byMemberName.values()) {
    if (indexes.length > 250) continue;
    indexes.sort((a, b) => a - b);
    for (let i = 0; i < indexes.length; i++) {
      for (let j = i + 1; j < indexes.length; j++) {
        const key = `${indexes[i]}:${indexes[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const overlaps = [];
  for (const [key, sharedCount] of pairCounts.entries()) {
    const [aIndex, bIndex] = key.split(":").map(Number);
    const a = indexToEntry.get(aIndex);
    const b = indexToEntry.get(bIndex);
    if (!a || !b) continue;
    if (a.file === b.file && a.name === b.name) continue;

    const denominator = Math.min(a.memberNames.length, b.memberNames.length);
    const score = denominator === 0 ? 0 : sharedCount / denominator;
    if (sharedCount < 2 || score < 0.6) continue;

    const aNames = new Set(a.memberNames);
    const bNames = new Set(b.memberNames);
    const sharedNames = a.memberNames.filter((name) => bNames.has(name));
    const aOnly = a.memberNames.filter((name) => !bNames.has(name));
    const bOnly = b.memberNames.filter((name) => !aNames.has(name));
    const relation =
      sharedCount === a.memberNames.length &&
      sharedCount === b.memberNames.length
        ? "identical-member-names"
        : sharedCount === a.memberNames.length
          ? "subset-member-names"
          : sharedCount === b.memberNames.length
            ? "superset-member-names"
            : "overlap-member-names";

    overlaps.push({
      score,
      relation,
      sharedCount,
      sharedNames,
      aOnly,
      bOnly,
      a: declarationRef(a),
      b: declarationRef(b),
    });
  }

  return overlaps
    .sort((a, b) => {
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      const byShared = b.sharedCount - a.sharedCount;
      if (byShared !== 0) return byShared;
      return `${a.a.name}:${a.b.name}`.localeCompare(`${b.a.name}:${b.b.name}`);
    })
    .slice(0, limit);
}

function packageSummary(entries) {
  const groups = groupBy(entries, (entry) => entry.packageName);
  return [...groups.entries()]
    .map(([packageName, group]) => ({
      packageName,
      count: group.length,
      interfaces: group.filter((entry) => entry.kind === "interface").length,
      types: group.filter((entry) => entry.kind === "type").length,
      enums: group.filter((entry) => entry.kind === "enum").length,
      duplicateNames: new Set(
        group
          .map((entry) => entry.name)
          .filter(
            (name) => group.filter((entry) => entry.name === name).length > 1,
          ),
      ).size,
    }))
    .sort(
      (a, b) => b.count - a.count || a.packageName.localeCompare(b.packageName),
    );
}

function emitGroupList(lines, title, groups, options = {}) {
  const limit = options.limit ?? 40;
  lines.push(`### ${title}`);
  lines.push("");
  if (groups.length === 0) {
    lines.push("No groups found.");
    lines.push("");
    return;
  }

  for (const group of groups.slice(0, limit)) {
    lines.push(
      `- ${group.count} declarations; names: ${group.names
        .map((name) => `\`${markdownEscape(name)}\``)
        .join(", ")}; packages: ${group.packages
        .map((pkg) => `\`${markdownEscape(pkg)}\``)
        .join(", ")}`,
    );
    const declarations = group.declarations.slice(
      0,
      options.declarationLimit ?? 8,
    );
    for (const declaration of declarations) {
      const keys = declaration.memberNames?.length
        ? `; members: \`${markdownEscape(declaration.memberNames.slice(0, 8).join(", "))}\``
        : "";
      lines.push(
        `  - \`${markdownEscape(declaration.file)}:${declaration.line}\` (${declaration.kind}${declaration.exported ? ", exported" : ""}${keys})`,
      );
    }
    if (group.declarations.length > declarations.length) {
      lines.push(
        `  - ... ${group.declarations.length - declarations.length} more`,
      );
    }
  }

  if (groups.length > limit) {
    lines.push("");
    lines.push(
      `Showing ${limit} of ${groups.length}; see JSON for the full set.`,
    );
  }
  lines.push("");
}

function emitNearOverlaps(lines, overlaps) {
  lines.push("### Near Member-Name Overlaps");
  lines.push("");
  if (overlaps.length === 0) {
    lines.push("No near overlaps found.");
    lines.push("");
    return;
  }

  for (const overlap of overlaps.slice(0, 50)) {
    lines.push(
      `- ${Math.round(overlap.score * 100)}% ${overlap.relation}: \`${markdownEscape(
        overlap.a.name,
      )}\` (\`${markdownEscape(overlap.a.file)}:${overlap.a.line}\`) vs \`${markdownEscape(
        overlap.b.name,
      )}\` (\`${markdownEscape(overlap.b.file)}:${overlap.b.line}\`)`,
    );
    lines.push(
      `  - shared: \`${markdownEscape(overlap.sharedNames.slice(0, 12).join(", "))}\``,
    );
    if (overlap.aOnly.length) {
      lines.push(
        `  - only ${markdownEscape(overlap.a.name)}: \`${markdownEscape(
          overlap.aOnly.slice(0, 8).join(", "),
        )}\``,
      );
    }
    if (overlap.bOnly.length) {
      lines.push(
        `  - only ${markdownEscape(overlap.b.name)}: \`${markdownEscape(
          overlap.bOnly.slice(0, 8).join(", "),
        )}\``,
      );
    }
  }

  if (overlaps.length > 50) {
    lines.push("");
    lines.push(`Showing 50 of ${overlaps.length}; see JSON for the full set.`);
  }
  lines.push("");
}

function generateReport(files, entries, analysis) {
  const lines = [];
  const summary = {
    declarations: entries.length,
    interfaces: entries.filter((entry) => entry.kind === "interface").length,
    types: entries.filter((entry) => entry.kind === "type").length,
    enums: entries.filter((entry) => entry.kind === "enum").length,
    exported: entries.filter((entry) => entry.exported).length,
    uniqueNames: new Set(entries.map((entry) => entry.name)).size,
  };

  lines.push("# Type Audit Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| TypeScript files scanned | ${files.length} |`);
  lines.push(`| Type/interface/enum declarations | ${summary.declarations} |`);
  lines.push(`| Interfaces | ${summary.interfaces} |`);
  lines.push(`| Type aliases | ${summary.types} |`);
  lines.push(`| Enums | ${summary.enums} |`);
  lines.push(`| Exported declarations | ${summary.exported} |`);
  lines.push(`| Unique names | ${summary.uniqueNames} |`);
  lines.push(`| Duplicate name groups | ${analysis.nameCollisions.length} |`);
  lines.push(
    `| Same name and same structure groups | ${analysis.sameNameSameStructure.length} |`,
  );
  lines.push(
    `| Different name but same structure groups | ${analysis.differentNameSameStructure.length} |`,
  );
  lines.push(
    `| Different name but same member-signature groups | ${analysis.differentNameSameMemberSignature.length} |`,
  );
  lines.push(
    `| Different name but same member-name groups | ${analysis.differentNameSameMemberNames.length} |`,
  );
  lines.push(
    `| Near overlap pairs retained | ${analysis.nearOverlaps.length} |`,
  );
  lines.push("");
  lines.push(
    `Roots: ${SCAN_ROOTS.map((root) => `\`${relative(root) || "."}\``).join(", ")}`,
  );
  lines.push(`Tests included: ${INCLUDE_TESTS ? "yes" : "no"}`);
  lines.push("");

  lines.push("## Package Breakdown");
  lines.push("");
  lines.push(
    "| Package | Total | Interfaces | Types | Enums | Local duplicate names |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const item of packageSummary(entries).slice(0, 80)) {
    lines.push(
      `| \`${markdownEscape(item.packageName)}\` | ${item.count} | ${item.interfaces} | ${item.types} | ${item.enums} | ${item.duplicateNames} |`,
    );
  }
  lines.push("");

  lines.push("## Consolidation Candidates");
  lines.push("");
  emitGroupList(
    lines,
    "Same Name and Same Canonical Structure",
    analysis.sameNameSameStructure,
    { limit: 80, declarationLimit: 10 },
  );
  emitGroupList(
    lines,
    "Different Name but Same Canonical Structure",
    analysis.differentNameSameStructure,
    { limit: 60, declarationLimit: 10 },
  );
  emitGroupList(
    lines,
    "Different Name but Same Member Signatures",
    analysis.differentNameSameMemberSignature,
    { limit: 60, declarationLimit: 10 },
  );
  emitGroupList(
    lines,
    "Different Name but Same Member Names",
    analysis.differentNameSameMemberNames,
    { limit: 60, declarationLimit: 10 },
  );
  emitNearOverlaps(lines, analysis.nearOverlaps);

  lines.push("## Name Collisions");
  lines.push("");
  emitGroupList(lines, "All Duplicate Names", analysis.nameCollisions, {
    limit: 120,
    declarationLimit: 12,
  });

  lines.push("## Full Inventory");
  lines.push("");
  lines.push(`<details><summary>All ${entries.length} declarations</summary>`);
  lines.push("");
  lines.push("| Name | Kind | Exported | Package | File | Line | Members |");
  lines.push("| --- | --- | --- | --- | --- | ---: | --- |");
  for (const entry of [...entries].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.file.localeCompare(b.file) || a.line - b.line;
  })) {
    const members =
      entry.memberNames.length > 8
        ? `${entry.memberNames.slice(0, 8).join(", ")}... (+${
            entry.memberNames.length - 8
          })`
        : entry.memberNames.join(", ");
    lines.push(
      `| \`${markdownEscape(entry.name)}\` | ${entry.kind} | ${
        entry.exported ? "yes" : "no"
      } | \`${markdownEscape(entry.packageName)}\` | \`${markdownEscape(entry.file)}\` | ${
        entry.line
      } | ${markdownEscape(members)} |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  lines.push("");

  return lines.join("\n");
}

console.log("Scanning TypeScript files...");
const files = collectFiles(SCAN_ROOTS);
console.log(`Found ${files.length} TypeScript files.`);

console.log("Extracting type/interface/enum declarations...");
const declarations = [];
const parseErrors = [];
let processed = 0;

for (const file of files) {
  try {
    declarations.push(...extractDeclarations(file));
  } catch (error) {
    parseErrors.push({
      file: relative(file),
      message: error instanceof Error ? error.message : String(error),
    });
  }

  processed++;
  if (processed % 250 === 0) {
    process.stdout.write(`  ${processed}/${files.length}\r`);
  }
}

console.log(`Extracted ${declarations.length} declarations.`);
if (parseErrors.length > 0) {
  console.log(`Skipped ${parseErrors.length} files with parse/read errors.`);
}

console.log("Grouping duplicate and overlapping declarations...");
const analysis = analyze(declarations);

console.log("Writing reports...");
fs.writeFileSync(
  OUTPUT_MD,
  generateReport(files, declarations, analysis),
  "utf8",
);
console.log(`Markdown report: ${OUTPUT_MD}`);

if (JSON_FLAG) {
  fs.writeFileSync(
    OUTPUT_JSON,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        roots: SCAN_ROOTS.map((root) => relative(root) || "."),
        includeTests: INCLUDE_TESTS,
        filesScanned: files.length,
        parseErrors,
        declarations,
        analysis,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`JSON report: ${OUTPUT_JSON}`);
}

console.log("Done.");
