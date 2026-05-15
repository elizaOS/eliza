#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const repoRoot = process.cwd();
const packagesRoot = path.join(repoRoot, "packages");
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const showAllowed = args.has("--show-allowed");

const targetPackagePattern = /^@elizaos\/(?:plugin|app)-[^/]*(?:\/.*)?$/;
const appCorePattern = /^@elizaos\/app-core(?:\/.*)?$/;
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const ignoredDirectoryNames = new Set([
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "docs",
  "node_modules",
  "snapshots",
  "__snapshots__",
]);

const ignoredFilePatterns = [
  /\.snap$/,
  /\.snapshot\.[cm]?[jt]sx?$/,
  /\.generated\.[cm]?[jt]sx?$/,
  /(^|\/)generated(\/|$)/,
  /(^|\/)registry.*\.json$/,
  /(^|\/)package\.json$/,
  /(^|\/)README(?:\.[^/]*)?$/i,
  /\.(md|mdx|txt|json)$/i,
];

function usage() {
  return `Usage: node scripts/audit-package-boundaries.mjs [--json] [--show-allowed]

Scans packages/ source files for imports from @elizaos/plugin-* and
@elizaos/app-* packages. Dynamic import() and @elizaos/app-core are allowed
and summarized separately unless --show-allowed is passed.`;
}

if (args.has("--help") || args.has("-h")) {
  console.log(usage());
  process.exit(0);
}

if (!fs.existsSync(packagesRoot)) {
  console.error(`Missing packages/ directory at ${packagesRoot}`);
  process.exit(2);
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativePath(filePath) {
  return toPosix(path.relative(repoRoot, filePath));
}

function shouldIgnoreFile(filePath) {
  const rel = relativePath(filePath);
  const parts = rel.split("/");
  if (parts.some((part) => ignoredDirectoryNames.has(part))) return true;
  return ignoredFilePatterns.some((pattern) => pattern.test(rel));
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) yield* walk(fullPath);
      continue;
    }
    if (
      entry.isFile() &&
      sourceExtensions.has(path.extname(entry.name)) &&
      !shouldIgnoreFile(fullPath)
    ) {
      yield fullPath;
    }
  }
}

function candidateFiles() {
  const globs = [...sourceExtensions].flatMap((extension) => [
    "-g",
    `*${extension}`,
  ]);
  const ignoreGlobs = [...ignoredDirectoryNames].flatMap((directory) => [
    "-g",
    `!**/${directory}/**`,
  ]);

  try {
    const output = execFileSync(
      "rg",
      [
        "--files-with-matches",
        "@elizaos/(plugin|app)-",
        "packages",
        ...globs,
        ...ignoreGlobs,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 32,
      },
    ).trim();
    return output
      ? output
          .split("\n")
          .map((file) => path.join(repoRoot, file))
          .filter((file) => !shouldIgnoreFile(file))
      : [];
  } catch (error) {
    if (error.status === 1) return [];
    return [...walk(packagesRoot)];
  }
}

function findPackageRoot(filePath) {
  let dir = path.dirname(filePath);
  while (dir.startsWith(packagesRoot)) {
    const manifestPath = path.join(dir, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        return {
          dir: relativePath(dir),
          name: typeof manifest.name === "string" ? manifest.name : null,
        };
      } catch {
        return { dir: relativePath(dir), name: null };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: null, name: null };
}

function scriptKindForFile(filePath) {
  switch (path.extname(filePath)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".cts":
    case ".mts":
    case ".ts":
    default:
      return ts.ScriptKind.TS;
  }
}

function lineForPosition(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function hasOnlyTypeNamedImports(importClause) {
  if (!importClause || importClause.name) return false;
  const namedBindings = importClause.namedBindings;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return false;
  return (
    namedBindings.elements.length > 0 &&
    namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function hasOnlyTypeNamedExports(exportClause) {
  if (!exportClause || !ts.isNamedExports(exportClause)) return false;
  return (
    exportClause.elements.length > 0 &&
    exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function collectSpecifier(node) {
  if (!node || !ts.isStringLiteralLike(node)) return null;
  return node.text;
}

function classifySpecifier(specifier) {
  if (!targetPackagePattern.test(specifier)) return null;
  if (appCorePattern.test(specifier)) return "app-core";
  return "violation";
}

function makeFinding({
  sourceFile,
  filePath,
  node,
  specifier,
  kind,
  usage,
  allowed,
  allowedReason = null,
}) {
  const owner = findPackageRoot(filePath);
  return {
    allowed,
    allowedReason,
    file: relativePath(filePath),
    kind,
    line: lineForPosition(sourceFile, node.getStart(sourceFile)),
    owner: owner.name,
    ownerDir: owner.dir,
    specifier,
    usage,
  };
}

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  if (!/@elizaos\/(?:plugin|app)-/.test(text)) return [];

  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(filePath),
  );
  const findings = [];

  function pushIfTarget(node, specifier, kind, usage) {
    const classification = classifySpecifier(specifier);
    if (!classification) return;
    findings.push(
      makeFinding({
        sourceFile,
        filePath,
        node,
        specifier,
        kind,
        usage,
        allowed: classification !== "violation",
        allowedReason:
          classification === "app-core" ? "app-core boundary allowed" : null,
      }),
    );
  }

  function inspectNode(node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = collectSpecifier(node.moduleSpecifier);
      if (specifier) {
        const typeOnly =
          Boolean(node.importClause?.isTypeOnly) ||
          hasOnlyTypeNamedImports(node.importClause);
        pushIfTarget(node, specifier, "import", typeOnly ? "type-only" : "static-runtime");
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = collectSpecifier(node.moduleSpecifier);
      if (specifier) {
        const typeOnly =
          Boolean(node.isTypeOnly) || hasOnlyTypeNamedExports(node.exportClause);
        pushIfTarget(node, specifier, "export", typeOnly ? "type-only" : "export");
      }
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1
      ) {
        const specifier = collectSpecifier(node.arguments[0]);
        const classification = specifier ? classifySpecifier(specifier) : null;
        if (specifier && classification) {
          findings.push(
            makeFinding({
              sourceFile,
              filePath,
              node,
              specifier,
              kind: "dynamic-import",
              usage: "dynamic-import",
              allowed: true,
              allowedReason: "dynamic import() is allowed",
            }),
          );
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1
      ) {
        const specifier = collectSpecifier(node.arguments[0]);
        if (specifier) pushIfTarget(node, specifier, "require", "require");
      }
    }
  }

  const stack = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop();
    inspectNode(node);
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return findings;
}

const allFindings = candidateFiles().flatMap(scanFile).sort((a, b) => {
  const fileCompare = a.file.localeCompare(b.file);
  if (fileCompare) return fileCompare;
  return a.line - b.line;
});

const violations = allFindings.filter((finding) => !finding.allowed);
const allowed = allFindings.filter((finding) => finding.allowed);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        scannedRoot: "packages",
        violations,
        allowed: showAllowed ? allowed : undefined,
        summary: {
          allowedAppCore: allowed.filter(
            (finding) => finding.allowedReason === "app-core boundary allowed",
          ).length,
          allowedDynamicImports: allowed.filter(
            (finding) => finding.usage === "dynamic-import",
          ).length,
          violations: violations.length,
        },
      },
      null,
      2,
    ),
  );
} else {
  if (violations.length === 0) {
    console.log("No package boundary violations found in packages/.");
  } else {
    console.log(`Package boundary violations in packages/: ${violations.length}`);
    for (const finding of violations) {
      console.log(
        [
          `${finding.file}:${finding.line}`,
          `owner=${finding.owner ?? finding.ownerDir ?? "unknown"}`,
          `specifier=${finding.specifier}`,
          `kind=${finding.kind}`,
          `usage=${finding.usage}`,
        ].join(" | "),
      );
    }
  }

  const dynamicCount = allowed.filter(
    (finding) => finding.usage === "dynamic-import",
  ).length;
  const appCoreCount = allowed.filter(
    (finding) => finding.allowedReason === "app-core boundary allowed",
  ).length;
  console.log(
    `Allowed references: dynamic import()=${dynamicCount}, @elizaos/app-core=${appCoreCount}`,
  );

  if (showAllowed && allowed.length > 0) {
    console.log("\nAllowed references:");
    for (const finding of allowed) {
      console.log(
        [
          `${finding.file}:${finding.line}`,
          `owner=${finding.owner ?? finding.ownerDir ?? "unknown"}`,
          `specifier=${finding.specifier}`,
          `kind=${finding.kind}`,
          `usage=${finding.usage}`,
          `reason=${finding.allowedReason}`,
        ].join(" | "),
      );
    }
  }
}

process.exitCode = violations.length > 0 ? 1 : 0;
