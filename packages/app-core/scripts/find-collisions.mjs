#!/usr/bin/env node
/**
 * Repository collision and boundary audit.
 *
 * Scans workspace TypeScript sources and reports:
 * - class name collisions
 * - exported function name collisions
 * - local/exported interface collisions
 * - local/exported type alias collisions
 * - pure re-export files
 * - internal workspace dependency and relative package-boundary violations
 *
 * Usage:
 *   node scripts/find-collisions.mjs
 *   node scripts/find-collisions.mjs --json
 *   node scripts/find-collisions.mjs --include-dts
 *
 * By default declaration files are excluded to reduce ambient/global noise.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_JSON = path.join(ROOT, "collision-report.json");
const JSON_FLAG = process.argv.includes("--json");
const INCLUDE_DTS = process.argv.includes("--include-dts");

const SCAN_ROOTS = ["packages", "apps", "scripts"]
  .map((dir) => path.join(ROOT, dir))
  .filter((dir) => fs.existsSync(dir));

const SYMBOL_KINDS = new Set(["class", "function", "interface", "type"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.d.ts",
];

const IGNORE_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.turbo(\/|$)/,
  /(^|\/)\.vite(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)storybook-static(\/|$)/,
  /(^|\/)test-results(\/|$)/,
  /(^|\/)android(\/|$)/,
  /(^|\/)ios(\/|$)/,
  /(^|\/)test\/contracts\/lib(\/|$)/,
  /\.test\.[mc]?[tj]sx?$/,
  /\.spec\.[mc]?[tj]sx?$/,
  /\.stories\.[mc]?[tj]sx?$/,
  /\.e2e\.[mc]?[tj]sx?$/,
];

function toRelative(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, "/");
}

function shouldIgnore(filePath) {
  const relativePath = toRelative(filePath);
  if (!INCLUDE_DTS && relativePath.endsWith(".d.ts")) {
    return true;
  }
  return IGNORE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function collectFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (shouldIgnore(fullPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      collectFiles(fullPath, results);
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      results.push(fullPath);
    }
  }
  return results;
}

function hasModifier(node, modifierKind) {
  return (
    node.modifiers?.some((modifier) => modifier.kind === modifierKind) ?? false
  );
}

function isFunctionVariableDeclaration(declaration) {
  return (
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  );
}

function isClassVariableDeclaration(declaration) {
  return (
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    ts.isClassExpression(declaration.initializer)
  );
}

function getLineNumber(sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return line + 1;
}

function normalizeMeaningfulLines(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("//") &&
        !line.startsWith("/*") &&
        !line.startsWith("*"),
    );
}

function isPureReexportFile(source) {
  const meaningfulLines = normalizeMeaningfulLines(source);
  if (meaningfulLines.length === 0) {
    return false;
  }
  return meaningfulLines.every((line) =>
    /^export(?:\s+type)?\s+(\*|\{)/u.test(line),
  );
}

function collectPackageInfo() {
  const packageFiles = [
    path.join(ROOT, "package.json"),
    ...globPackageJson(path.join(ROOT, "packages")),
    ...globPackageJson(path.join(ROOT, "apps")),
    ...globPackageJson(path.join(ROOT, "apps", "app", "plugins")),
    path.join(ROOT, "apps", "app", "electrobun", "package.json"),
  ].filter(
    (filePath, index, list) =>
      list.indexOf(filePath) === index && fs.existsSync(filePath),
  );

  const packageInfos = packageFiles
    .map((filePath) => {
      const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      };
      return {
        dir: path.dirname(filePath),
        name: manifest.name ?? null,
        relativeDir: toRelative(path.dirname(filePath)),
        internalDependencies: new Set(Object.keys(dependencies ?? {})),
      };
    })
    .filter((info) => info.name);

  packageInfos.sort((a, b) => b.dir.length - a.dir.length);
  return packageInfos;
}

function globPackageJson(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageJson = path.join(rootDir, entry.name, "package.json");
    if (fs.existsSync(packageJson)) {
      results.push(packageJson);
    }
  }
  return results;
}

function findOwnerPackage(filePath, packageInfos) {
  return (
    packageInfos.find(
      (info) =>
        filePath === info.dir || filePath.startsWith(`${info.dir}${path.sep}`),
    ) ?? null
  );
}

function resolveRelativeImport(fromFile, specifier) {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  for (const suffix of RESOLVE_EXTENSIONS) {
    const candidate = `${basePath}${suffix}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function createCollisionBuckets() {
  return {
    classCollisions: new Map(),
    exportedFunctionCollisions: new Map(),
    localInterfaceCollisions: new Map(),
    exportedInterfaceCollisions: new Map(),
    localTypeCollisions: new Map(),
    exportedTypeCollisions: new Map(),
  };
}

function addToGroup(map, record) {
  const existing = map.get(record.name) ?? [];
  existing.push(record);
  map.set(record.name, existing);
}

function collapseCollisionMap(map) {
  return [...map.entries()]
    .map(([name, entries]) => ({
      name,
      entries: entries.sort(
        (left, right) =>
          left.file.localeCompare(right.file) || left.line - right.line,
      ),
    }))
    .filter(
      ({ entries }) => new Set(entries.map((entry) => entry.file)).size > 1,
    )
    .sort(
      (left, right) =>
        right.entries.length - left.entries.length ||
        left.name.localeCompare(right.name),
    );
}

function summarizeViolations(violations) {
  const byPackage = new Map();
  for (const violation of violations) {
    const existing = byPackage.get(violation.packageName) ?? {
      packageName: violation.packageName,
      count: 0,
      examples: [],
    };
    existing.count += 1;
    if (existing.examples.length < 25) {
      existing.examples.push({
        file: violation.file,
        kind: violation.kind,
        specifier: violation.specifier,
        targetPackage: violation.targetPackage,
        targetFile: violation.targetFile,
      });
    }
    byPackage.set(violation.packageName, existing);
  }
  return [...byPackage.values()].sort(
    (left, right) => right.count - left.count,
  );
}

function dedupeByKey(entries, getKey) {
  const map = new Map();
  for (const entry of entries) {
    const key = getKey(entry);
    const existing = map.get(key);
    if (!existing || entry.line < existing.line) {
      map.set(key, entry);
    }
  }
  return [...map.values()];
}

function extractRecords(filePath, packageInfos) {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const ownerPackage = findOwnerPackage(filePath, packageInfos);
  const relativeFile = toRelative(filePath);
  const symbols = [];
  const localSymbolIndexes = new Map();
  const imports = [];
  const exportedAliasKeys = new Set();

  function addSymbol(name, kind, node, exported, sourceName = name) {
    if (!name || !SYMBOL_KINDS.has(kind)) {
      return;
    }
    const record = {
      name,
      kind,
      exported,
      file: relativeFile,
      line: getLineNumber(sourceFile, node),
      packageName: ownerPackage?.name ?? null,
      packageDir: ownerPackage?.relativeDir ?? null,
      sourceName,
    };
    const index = symbols.push(record) - 1;
    if (name === sourceName) {
      const existing = localSymbolIndexes.get(name) ?? [];
      existing.push(index);
      localSymbolIndexes.set(name, existing);
    }
  }

  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        line: getLineNumber(sourceFile, node),
        type: "import",
      });
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        line: getLineNumber(sourceFile, node),
        type: "re-export",
      });
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      addSymbol(
        node.name.text,
        "function",
        node,
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
      );
    }

    if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(
        node.name.text,
        "class",
        node,
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
      );
    }

    if (ts.isInterfaceDeclaration(node) && node.name) {
      addSymbol(
        node.name.text,
        "interface",
        node,
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
      );
    }

    if (ts.isTypeAliasDeclaration(node) && node.name) {
      addSymbol(
        node.name.text,
        "type",
        node,
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
      );
    }

    if (ts.isVariableStatement(node)) {
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      for (const declaration of node.declarationList.declarations) {
        if (isFunctionVariableDeclaration(declaration)) {
          addSymbol(declaration.name.text, "function", declaration, exported);
        }
        if (isClassVariableDeclaration(declaration)) {
          addSymbol(declaration.name.text, "class", declaration, exported);
        }
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const exportedName = element.name.text;
        const matchingIndexes = localSymbolIndexes.get(localName) ?? [];
        for (const index of matchingIndexes) {
          const symbol = symbols[index];
          if (!SYMBOL_KINDS.has(symbol.kind)) {
            continue;
          }
          if (symbol.name === exportedName) {
            symbol.exported = true;
            continue;
          }
          const aliasKey = `${symbol.kind}:${localName}:${exportedName}:${relativeFile}`;
          if (exportedAliasKeys.has(aliasKey)) {
            continue;
          }
          exportedAliasKeys.add(aliasKey);
          symbols.push({
            ...symbol,
            name: exportedName,
            exported: true,
            sourceName: localName,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    file: relativeFile,
    packageName: ownerPackage?.name ?? null,
    packageDir: ownerPackage?.relativeDir ?? null,
    symbols,
    imports,
    pureReexport: isPureReexportFile(source),
  };
}

function analyzeWorkspace() {
  const packageInfos = collectPackageInfo();
  const files = SCAN_ROOTS.flatMap((dir) => collectFiles(dir)).sort();
  const buckets = createCollisionBuckets();
  const symbolRecords = [];
  const pureReexports = [];
  const hierarchyViolations = [];

  for (const filePath of files) {
    const extracted = extractRecords(filePath, packageInfos);
    symbolRecords.push(...extracted.symbols);

    if (extracted.pureReexport) {
      const externalSpecifiers = extracted.imports
        .map((entry) => entry.specifier)
        .filter((specifier) => specifier.startsWith("@elizaos/"));
      pureReexports.push({
        file: extracted.file,
        packageName: extracted.packageName,
        externalSpecifiers,
      });
    }

    const shouldCheckHierarchy =
      extracted.file.includes("/src/") || extracted.file.startsWith("src/");

    for (const entry of extracted.imports) {
      if (!shouldCheckHierarchy || !extracted.packageName) {
        continue;
      }

      if (entry.specifier.startsWith("@elizaos/")) {
        const targetPackage = entry.specifier.split("/").slice(0, 2).join("/");
        const ownerPackage = packageInfos.find(
          (info) => info.name === extracted.packageName,
        );
        if (
          targetPackage !== extracted.packageName &&
          ownerPackage &&
          !ownerPackage.internalDependencies.has(targetPackage)
        ) {
          hierarchyViolations.push({
            packageName: extracted.packageName,
            file: extracted.file,
            kind: "missing-internal-dependency",
            specifier: entry.specifier,
            targetPackage,
            targetFile: null,
          });
        }
        continue;
      }

      if (!entry.specifier.startsWith(".")) {
        continue;
      }

      const absoluteFile = path.join(ROOT, extracted.file);
      const targetFile = resolveRelativeImport(absoluteFile, entry.specifier);
      if (!targetFile) {
        continue;
      }

      const targetOwner = findOwnerPackage(targetFile, packageInfos);
      if (!targetOwner || targetOwner.name === extracted.packageName) {
        continue;
      }

      hierarchyViolations.push({
        packageName: extracted.packageName,
        file: extracted.file,
        kind: "cross-package-relative-import",
        specifier: entry.specifier,
        targetPackage: targetOwner.name,
        targetFile: toRelative(targetFile),
      });
    }
  }

  for (const record of symbolRecords) {
    if (record.kind === "class") {
      addToGroup(buckets.classCollisions, record);
      continue;
    }
    if (record.kind === "function" && record.exported) {
      addToGroup(buckets.exportedFunctionCollisions, record);
      continue;
    }
    if (record.kind === "interface" && record.exported) {
      addToGroup(buckets.exportedInterfaceCollisions, record);
      continue;
    }
    if (record.kind === "interface" && !record.exported) {
      addToGroup(buckets.localInterfaceCollisions, record);
      continue;
    }
    if (record.kind === "type" && record.exported) {
      addToGroup(buckets.exportedTypeCollisions, record);
      continue;
    }
    if (record.kind === "type" && !record.exported) {
      addToGroup(buckets.localTypeCollisions, record);
    }
  }

  const dedupedSymbols = dedupeByKey(symbolRecords, (record) =>
    [
      record.kind,
      record.exported ? "exported" : "local",
      record.file,
      record.name,
    ].join(":"),
  );

  const dedupedViolations = dedupeByKey(hierarchyViolations, (record) =>
    [
      record.packageName,
      record.file,
      record.kind,
      record.specifier,
      record.targetPackage ?? "",
      record.targetFile ?? "",
    ].join(":"),
  );

  for (const key of Object.keys(buckets)) {
    buckets[key].clear();
  }

  for (const record of dedupedSymbols) {
    if (record.kind === "class") {
      addToGroup(buckets.classCollisions, record);
      continue;
    }
    if (record.kind === "function" && record.exported) {
      addToGroup(buckets.exportedFunctionCollisions, record);
      continue;
    }
    if (record.kind === "interface" && record.exported) {
      addToGroup(buckets.exportedInterfaceCollisions, record);
      continue;
    }
    if (record.kind === "interface" && !record.exported) {
      addToGroup(buckets.localInterfaceCollisions, record);
      continue;
    }
    if (record.kind === "type" && record.exported) {
      addToGroup(buckets.exportedTypeCollisions, record);
      continue;
    }
    if (record.kind === "type" && !record.exported) {
      addToGroup(buckets.localTypeCollisions, record);
    }
  }

  const collisions = Object.fromEntries(
    Object.entries(buckets).map(([key, map]) => [
      key,
      collapseCollisionMap(map),
    ]),
  );

  const pureReexportSummary = {
    total: pureReexports.length,
    externalBridgeCount: pureReexports.filter(
      (record) => record.externalSpecifiers.length > 0,
    ).length,
    files: pureReexports.sort((left, right) =>
      left.file.localeCompare(right.file),
    ),
  };

  const hierarchySummary = {
    total: dedupedViolations.length,
    byPackage: summarizeViolations(dedupedViolations),
    entries: dedupedViolations.sort(
      (left, right) =>
        left.packageName.localeCompare(right.packageName) ||
        left.file.localeCompare(right.file) ||
        left.specifier.localeCompare(right.specifier),
    ),
  };

  return {
    generatedAt: new Date().toISOString(),
    scannedFiles: files.length,
    includeDeclarationFiles: INCLUDE_DTS,
    symbolCount: dedupedSymbols.length,
    pureReexports: pureReexportSummary,
    hierarchyViolations: hierarchySummary,
    collisions,
  };
}

function printGroup(title, groups, limit = 15) {
  console.log(`\n=== ${title} ===\n`);
  if (groups.length === 0) {
    console.log("  None found.");
    return;
  }
  for (const group of groups.slice(0, limit)) {
    console.log(`  ${group.name} (${group.entries.length} definitions)`);
    for (const entry of group.entries.slice(0, 8)) {
      const exportLabel = entry.exported ? "exported" : "local";
      const packageLabel = entry.packageName ? `, ${entry.packageName}` : "";
      console.log(
        `    ${entry.file}:${entry.line} [${entry.kind}, ${exportLabel}${packageLabel}]`,
      );
    }
  }
  if (groups.length > limit) {
    console.log(`  ... and ${groups.length - limit} more`);
  }
}

function printViolations(summary, limit = 30) {
  console.log("\n=== Package Boundary Violations ===\n");
  if (summary.total === 0) {
    console.log("  None found.");
    return;
  }
  console.log(`  Total: ${summary.total}`);
  for (const packageSummary of summary.byPackage.slice(0, 10)) {
    console.log(`  ${packageSummary.packageName}: ${packageSummary.count}`);
  }
  console.log();
  for (const violation of summary.entries.slice(0, limit)) {
    const target = violation.targetFile
      ? `${violation.targetPackage} -> ${violation.targetFile}`
      : violation.targetPackage;
    console.log(
      `  ${violation.file} [${violation.kind}] ${violation.specifier} -> ${target}`,
    );
  }
  if (summary.entries.length > limit) {
    console.log(`  ... and ${summary.entries.length - limit} more`);
  }
}

function printPureReexports(summary, limit = 30) {
  console.log("\n=== Pure Re-export Files ===\n");
  console.log(`  Total: ${summary.total}`);
  console.log(`  Cross-package bridges: ${summary.externalBridgeCount}`);
  for (const record of summary.files
    .filter((entry) => entry.externalSpecifiers.length > 0)
    .slice(0, limit)) {
    console.log(`  ${record.file}`);
  }
  if (summary.externalBridgeCount > limit) {
    console.log(`  ... and ${summary.externalBridgeCount - limit} more`);
  }
}

const report = analyzeWorkspace();

if (JSON_FLAG) {
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2), "utf8");
  console.log(`Written to ${toRelative(OUTPUT_JSON)}`);
  process.exit(0);
}

console.log("\n=== Repository Audit Summary ===\n");
console.log(`  Scanned files: ${report.scannedFiles}`);
console.log(`  Symbols: ${report.symbolCount}`);
console.log(`  Pure re-export files: ${report.pureReexports.total}`);
console.log(
  `  Cross-package re-export bridges: ${report.pureReexports.externalBridgeCount}`,
);
console.log(
  `  Package boundary violations: ${report.hierarchyViolations.total}`,
);
console.log(`  Class collisions: ${report.collisions.classCollisions.length}`);
console.log(
  `  Exported function collisions: ${report.collisions.exportedFunctionCollisions.length}`,
);
console.log(
  `  Local interface collisions: ${report.collisions.localInterfaceCollisions.length}`,
);
console.log(
  `  Exported interface collisions: ${report.collisions.exportedInterfaceCollisions.length}`,
);
console.log(
  `  Local type collisions: ${report.collisions.localTypeCollisions.length}`,
);
console.log(
  `  Exported type collisions: ${report.collisions.exportedTypeCollisions.length}`,
);

printGroup("Class Collisions", report.collisions.classCollisions);
printGroup(
  "Exported Function Collisions",
  report.collisions.exportedFunctionCollisions,
);
printGroup(
  "Local Interface Collisions",
  report.collisions.localInterfaceCollisions,
);
printGroup(
  "Exported Interface Collisions",
  report.collisions.exportedInterfaceCollisions,
);
printGroup("Local Type Collisions", report.collisions.localTypeCollisions);
printGroup(
  "Exported Type Collisions",
  report.collisions.exportedTypeCollisions,
);
printViolations(report.hierarchyViolations);
printPureReexports(report.pureReexports);
