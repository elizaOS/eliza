#!/usr/bin/env node
/**
 * Audits whole-module Bun mocks against the named exports bound by the local
 * module graph each test loads. TypeScript resolution supplies the canonical
 * source identity, while explicit ignores and real-module spreads keep
 * deliberate partial mocks reviewable without weakening unrelated factories.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_FILE = /(?:^|[/\\])[^/\\]+[._](?:test|spec)\.[cm]?[jt]sx?$/i;
const SKIP_PATH =
  /(?:^|[/\\])(?:node_modules|dist|build|coverage|vendor)(?:[/\\]|$)/;
const IGNORE_MARKER = "mock-exports-audit: ignore";
const BASELINE_FILE =
  "packages/scripts/audit-mock-module-exports.baseline.json";

function compareText(left, right) {
  return left.localeCompare(right, "en-US");
}

function normalizeFile(file) {
  return path.resolve(file);
}

function contained(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function canonicalFile(file) {
  const absolute = normalizeFile(file);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function scriptKind(file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  if (!node) return undefined;
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

function repositoryFiles(repoRoot) {
  return execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "packages",
      "plugins",
      "scripts",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter((file) => SOURCE_EXTENSION.test(file) && !SKIP_PATH.test(file))
    .map((file) => normalizeFile(path.join(repoRoot, file)));
}

function parseCompilerOptions(configFile) {
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
    );
  }
  return ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configFile),
    undefined,
    configFile,
  ).options;
}

function compilerOptionsFor(file, repoRoot, cache) {
  const config = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  const configFile = config && contained(repoRoot, config) ? config : undefined;
  const cacheKey = configFile ?? "<default>";
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const defaults = {
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  };
  const candidates = [];
  if (configFile) {
    candidates.push(parseCompilerOptions(configFile));
    const configDir = path.dirname(configFile);
    for (const sibling of ts.sys.readDirectory(
      configDir,
      [".json"],
      undefined,
      ["tsconfig.*.json"],
      1,
    )) {
      if (canonicalFile(sibling) !== canonicalFile(configFile)) {
        candidates.push(parseCompilerOptions(sibling));
      }
    }
  }
  const rootConfig = path.join(repoRoot, "tsconfig.json");
  if (
    existsSync(rootConfig) &&
    canonicalFile(rootConfig) !== canonicalFile(configFile ?? rootConfig)
  ) {
    candidates.push(parseCompilerOptions(rootConfig));
  }
  if (candidates.length === 0) candidates.push(defaults);
  cache.set(cacheKey, candidates);
  return candidates;
}

function createAnalyzer(repoRoot, candidateFiles) {
  const root = canonicalFile(repoRoot);
  const sources = new Map();
  const compilerOptions = new Map();
  const resolutions = new Map();
  const declarations = new Map();
  const namespaceImports = new Map();
  const moduleEdges = new Map();

  function source(file) {
    const canonical = canonicalFile(file);
    const cached = sources.get(canonical);
    if (cached) return cached;
    const parsed = ts.createSourceFile(
      canonical,
      readFileSync(canonical, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(canonical),
    );
    sources.set(canonical, parsed);
    return parsed;
  }

  function resolve(specifier, fromFile) {
    const containingFile = canonicalFile(fromFile);
    const key = `${containingFile}\0${specifier}`;
    if (resolutions.has(key)) return resolutions.get(key);
    const cleanSpecifier = specifier.replace(/[?#].*$/, "");
    const optionCandidates = compilerOptionsFor(
      containingFile,
      root,
      compilerOptions,
    );
    let resolved;
    for (const options of optionCandidates) {
      resolved = ts.resolveModuleName(
        cleanSpecifier,
        containingFile,
        options,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (resolved) break;
    }
    const canonical = resolved ? canonicalFile(resolved) : undefined;
    if (
      canonical &&
      !contained(root, canonical) &&
      (specifier.startsWith("@/") || specifier.startsWith("@elizaos/"))
    ) {
      throw new Error(
        `[mock-module-exports] internal module ${JSON.stringify(specifier)} from ${path.relative(root, containingFile)} resolves outside the repository to ${canonical}; run from a frozen in-repository Bun install`,
      );
    }
    const internal =
      canonical && contained(root, canonical) && !SKIP_PATH.test(canonical)
        ? canonical
        : undefined;
    resolutions.set(key, internal);
    return internal;
  }

  function declarationsFor(parsed) {
    const cached = declarations.get(parsed.fileName);
    if (cached) return cached;
    const found = new Map();
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        found.set(node.name.text, node.initializer);
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        found.set(node.name.text, node);
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    declarations.set(parsed.fileName, found);
    return found;
  }

  function namespaceImportsFor(parsed) {
    const cached = namespaceImports.get(parsed.fileName);
    if (cached) return cached;
    const found = new Map();
    for (const statement of parsed.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings)
      ) {
        found.set(
          statement.importClause.namedBindings.name.text,
          statement.moduleSpecifier.text,
        );
      }
    }
    namespaceImports.set(parsed.fileName, found);
    return found;
  }

  function resolveExpression(node, parsed, seen = new Set()) {
    const current = unwrap(node);
    if (!current || !ts.isIdentifier(current)) return current;
    if (seen.has(current.text)) return current;
    const declaration = declarationsFor(parsed).get(current.text);
    if (!declaration) return current;
    seen.add(current.text);
    return resolveExpression(declaration, parsed, seen);
  }

  function dynamicImportSpecifier(node) {
    const current = unwrap(node);
    return current &&
      ts.isCallExpression(current) &&
      current.expression.kind === ts.SyntaxKind.ImportKeyword &&
      current.arguments.length === 1 &&
      isStringLiteral(current.arguments[0])
      ? current.arguments[0].text
      : undefined;
  }

  function isRealModuleExpression(node, parsed, target, seen = new Set()) {
    const current = unwrap(node);
    if (!current) return false;
    const specifier = dynamicImportSpecifier(current);
    if (specifier) return resolve(specifier, parsed.fileName) === target;
    if (!ts.isIdentifier(current) || seen.has(current.text)) return false;
    const namespaceSpecifier = namespaceImportsFor(parsed).get(current.text);
    if (namespaceSpecifier) {
      return resolve(namespaceSpecifier, parsed.fileName) === target;
    }
    const declaration = declarationsFor(parsed).get(current.text);
    if (!declaration) return false;
    seen.add(current.text);
    return isRealModuleExpression(declaration, parsed, target, seen);
  }

  function returnedExpressions(factoryNode, parsed) {
    const factory = resolveExpression(factoryNode, parsed);
    if (!factory) return [];
    if (ts.isObjectLiteralExpression(factory)) return [factory];
    if (
      !ts.isArrowFunction(factory) &&
      !ts.isFunctionExpression(factory) &&
      !ts.isFunctionDeclaration(factory)
    ) {
      return [];
    }
    if (!ts.isBlock(factory.body)) {
      return [resolveExpression(factory.body, parsed)].filter(Boolean);
    }
    const expressions = [];
    function visit(node) {
      if (ts.isFunctionLike(node) && node !== factory) return;
      if (ts.isReturnStatement(node) && node.expression) {
        expressions.push(resolveExpression(node.expression, parsed));
      }
      ts.forEachChild(node, visit);
    }
    visit(factory.body);
    return expressions.filter(Boolean);
  }

  function factoryExports(factoryNode, parsed, target) {
    const expressions = returnedExpressions(factoryNode, parsed);
    if (expressions.length === 0)
      return { analyzable: false, names: new Set(), realSpread: false };
    const variants = [];
    for (const expression of expressions) {
      if (isRealModuleExpression(expression, parsed, target)) {
        variants.push({ names: new Set(), realSpread: true });
        continue;
      }
      if (!ts.isObjectLiteralExpression(expression)) {
        return { analyzable: false, names: new Set(), realSpread: false };
      }
      const names = new Set();
      let realSpread = false;
      const object = expression;
      for (const member of object.properties) {
        if (ts.isSpreadAssignment(member)) {
          if (isRealModuleExpression(member.expression, parsed, target))
            realSpread = true;
          continue;
        }
        const name = propertyName(member.name);
        if (name !== undefined) names.add(name);
      }
      variants.push({ names, realSpread });
    }
    const realSpread = variants.every((variant) => variant.realSpread);
    const concrete = variants.filter((variant) => !variant.realSpread);
    const names = new Set(concrete[0]?.names ?? []);
    for (const variant of concrete.slice(1)) {
      for (const name of names) {
        if (!variant.names.has(name)) names.delete(name);
      }
    }
    return { analyzable: true, names, realSpread };
  }

  function mocksInFile(parsed) {
    const mocks = [];
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(parsed) === "mock" &&
        node.expression.name.text === "module" &&
        node.arguments.length >= 2 &&
        isStringLiteral(node.arguments[0])
      ) {
        const { line } = parsed.getLineAndCharacterOfPosition(
          node.getStart(parsed),
        );
        mocks.push({
          call: node,
          factory: node.arguments[1],
          line: line + 1,
          specifier: node.arguments[0].text,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    return mocks;
  }

  function namespaceMemberNames(parsed, identifier) {
    const names = new Set();
    function visit(node) {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === identifier
      )
        names.add(node.name.text);
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === identifier &&
        node.argumentExpression &&
        isStringLiteral(node.argumentExpression)
      )
        names.add(node.argumentExpression.text);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    return [...names];
  }

  function importBindingNames(node, parsed) {
    const names = [];
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause || clause.isTypeOnly) return names;
      if (clause.name) names.push("default");
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly)
            names.push(element.propertyName?.text ?? element.name.text);
        }
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        names.push(
          ...namespaceMemberNames(parsed, clause.namedBindings.name.text),
        );
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      if (!node.isTypeOnly) {
        for (const element of node.exportClause.elements) {
          if (!element.isTypeOnly)
            names.push(element.propertyName?.text ?? element.name.text);
        }
      }
    }
    return names;
  }

  function directDynamicImportBindingNames(node) {
    let current = node;
    let awaited = false;
    while (
      current.parent &&
      (ts.isAwaitExpression(current.parent) ||
        ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent))
    ) {
      if (ts.isAwaitExpression(current.parent)) awaited = true;
      current = current.parent;
    }
    // `import(...).then(...)` accesses the Promise contract, not a module export.
    if (!awaited) return [];
    if (
      current.parent &&
      ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current
    ) {
      return [current.parent.name.text];
    }
    if (
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isObjectBindingPattern(current.parent.name)
    ) {
      return current.parent.name.elements
        .filter((element) => !element.dotDotDotToken)
        .map((element) => propertyName(element.propertyName ?? element.name))
        .filter((name) => name !== undefined);
    }
    return [];
  }

  function moduleEdgesFor(file) {
    const cached = moduleEdges.get(file);
    if (cached) return cached;
    const parsed = source(file);
    const edges = [];
    function visit(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      } else {
        specifier = dynamicImportSpecifier(node);
      }
      if (specifier) {
        const target = resolve(specifier, file);
        const names = ts.isCallExpression(node)
          ? directDynamicImportBindingNames(node)
          : importBindingNames(node, parsed);
        edges.push({
          names,
          target,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    moduleEdges.set(file, edges);
    return edges;
  }

  function reachableBindings(testFile, targets) {
    const required = new Map([...targets].map((target) => [target, new Set()]));
    const visited = new Set();
    const queue = [canonicalFile(testFile)];
    while (queue.length > 0) {
      const file = queue.shift();
      if (visited.has(file) || !SOURCE_EXTENSION.test(file)) continue;
      visited.add(file);
      for (const edge of moduleEdgesFor(file)) {
        if (required.has(edge.target)) {
          for (const name of edge.names) {
            required.get(edge.target).add(name);
          }
        } else if (edge.target && !visited.has(edge.target)) {
          queue.push(edge.target);
        }
      }
    }
    return required;
  }

  function ignoreDirectives(parsed) {
    const sourceText = parsed.text;
    const valid = [];
    const malformed = [];
    for (const line of sourceText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//") && !trimmed.startsWith("*")) continue;
      if (!line.includes(IGNORE_MARKER)) continue;
      const match = line.match(
        /mock-exports-audit:\s*ignore\s+(\*|[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s+--\s+(.+)$/,
      );
      if (!match || match[2].trim().length < 12) {
        malformed.push(line.trim());
        continue;
      }
      valid.push({
        names:
          match[1] === "*"
            ? ["*"]
            : match[1].split(",").map((name) => name.trim()),
        reason: match[2].trim(),
      });
    }
    return { malformed, valid };
  }

  function auditTest(testFile) {
    const parsed = source(testFile);
    const mocks = mocksInFile(parsed);
    const directives = ignoreDirectives(parsed);
    const findings = directives.malformed.map(
      (line) => `[invalid-ignore] ${path.relative(root, testFile)}: ${line}`,
    );
    const usedIgnores = new Set();
    const ignored = new Set(
      directives.valid.flatMap((directive) => directive.names),
    );
    const resolvedMocks = [];
    for (const mock of mocks) {
      const internalLooking =
        mock.specifier.startsWith(".") ||
        mock.specifier.startsWith("@/") ||
        mock.specifier.startsWith("@elizaos/");
      const target = resolve(mock.specifier, testFile);
      if (!target) {
        if (internalLooking) {
          findings.push(
            `[unresolved-module] ${path.relative(root, testFile)}:${mock.line} cannot resolve internal mock ${JSON.stringify(mock.specifier)}`,
          );
        }
        continue;
      }
      resolvedMocks.push({ ...mock, target });
    }
    const bindings = reachableBindings(
      testFile,
      new Set(resolvedMocks.map(({ target }) => target)),
    );
    for (const mock of resolvedMocks) {
      const required = bindings.get(mock.target);
      if (required.size === 0) continue;
      const factory = factoryExports(mock.factory, parsed, mock.target);
      if (factory.realSpread) continue;
      const missing = [...required].filter((name) => !factory.names.has(name));
      const unsuppressed = missing.filter((name) => {
        if (ignored.has("*")) {
          usedIgnores.add("*");
          return false;
        }
        if (ignored.has(name)) {
          usedIgnores.add(name);
          return false;
        }
        return true;
      });
      if (!factory.analyzable && unsuppressed.length > 0) {
        findings.push(
          `[unsupported-factory] ${path.relative(root, testFile)}:${mock.line} mock ${JSON.stringify(mock.specifier)} must return an object literal, spread the real module, or explicitly ignore: ${unsuppressed.sort(compareText).join(", ")}`,
        );
      } else if (unsuppressed.length > 0) {
        findings.push(
          `[missing-export] ${path.relative(root, testFile)}:${mock.line} mock ${JSON.stringify(mock.specifier)} is missing bound export(s): ${unsuppressed.sort(compareText).join(", ")}`,
        );
      }
    }
    for (const directive of directives.valid) {
      for (const name of directive.names) {
        if (!usedIgnores.has(name)) {
          findings.push(
            `[stale-ignore] ${path.relative(root, testFile)} ignores ${name}, but no audited mock needs that suppression`,
          );
        }
      }
    }
    return { findings, mockCount: mocks.length };
  }

  function audit() {
    const findings = [];
    let mockCount = 0;
    let testCount = 0;
    for (const file of candidateFiles.sort(compareText)) {
      if (!TEST_FILE.test(file)) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("mock.module")) continue;
      testCount += 1;
      const result = auditTest(file);
      mockCount += result.mockCount;
      findings.push(...result.findings);
    }
    return { findings: findings.sort(compareText), mockCount, testCount };
  }

  return { audit, resolve, source };
}

/** Audit a repository or deterministic fixture tree. */
export function auditMockModuleExports(
  repoRoot,
  files = repositoryFiles(repoRoot),
) {
  return createAnalyzer(repoRoot, files.map(canonicalFile)).audit();
}

function findingFingerprint(finding) {
  return finding.replace(/^(\[[^\]]+\] [^:\n]+):\d+ /, "$1 ");
}

function findingCounts(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

/** Compare current findings with a sorted, counted debt baseline. */
export function reconcileMockExportBaseline(findings, baseline) {
  const expected = new Map();
  let previous;
  for (const record of baseline) {
    if (
      !record ||
      typeof record.finding !== "string" ||
      !Number.isSafeInteger(record.count) ||
      record.count < 1
    ) {
      throw new Error(
        `${BASELINE_FILE} entries must be { finding: string, count: positive integer }`,
      );
    }
    if (previous !== undefined && compareText(previous, record.finding) >= 0) {
      throw new Error(`${BASELINE_FILE} must be sorted with unique findings`);
    }
    expected.set(record.finding, record.count);
    previous = record.finding;
  }
  const actual = findingCounts(findings);
  const violations = [];
  for (const finding of new Set([...expected.keys(), ...actual.keys()])) {
    const expectedCount = expected.get(finding) ?? 0;
    const actualCount = actual.get(finding) ?? 0;
    if (actualCount > expectedCount) {
      violations.push(
        `[new-finding] ${finding} (${actualCount - expectedCount} above baseline)`,
      );
    } else if (actualCount < expectedCount) {
      violations.push(
        `[stale-baseline] ${finding} (${expectedCount - actualCount} no longer reproduced)`,
      );
    }
  }
  return violations.sort(compareText);
}

function baselineRecords(findings) {
  return [...findingCounts(findings)]
    .map(([finding, count]) => ({ finding, count }))
    .sort((left, right) => compareText(left.finding, right.finding));
}

function main() {
  const args = process.argv.slice(2);
  let repoRoot = DEFAULT_ROOT;
  let updateBaseline = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) {
      repoRoot = normalizeFile(args[index + 1]);
      index += 1;
    } else if (args[index] === "--update-baseline") {
      updateBaseline = true;
    } else {
      throw new Error(
        "usage: audit-mock-module-exports.mjs [--root DIR] [--update-baseline]",
      );
    }
  }
  const report = auditMockModuleExports(repoRoot);
  const baselinePath = path.join(repoRoot, BASELINE_FILE);
  if (updateBaseline) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify(baselineRecords(report.findings), null, 2)}\n`,
    );
    console.log(
      `[mock-module-exports] updated ${BASELINE_FILE} with ${report.findings.length} finding instance(s).`,
    );
    return;
  }
  if (!existsSync(baselinePath)) {
    throw new Error(`${BASELINE_FILE} is missing; run with --update-baseline`);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!Array.isArray(baseline)) {
    throw new Error(`${BASELINE_FILE} must be a JSON array`);
  }
  const violations = reconcileMockExportBaseline(report.findings, baseline);
  if (violations.length > 0) {
    for (const finding of violations) console.error(finding);
    console.error(
      `[mock-module-exports] FAIL ${violations.length} baseline violation(s); ${report.findings.length} known finding instance(s) across ${report.mockCount} mock(s) in ${report.testCount} test file(s).`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[mock-module-exports] PASS ${report.mockCount} mock(s) in ${report.testCount} test file(s); ${report.findings.length} known finding instance(s) are ratcheted by ${BASELINE_FILE}.`,
  );
}

if (
  process.argv[1] &&
  canonicalFile(process.argv[1]) ===
    canonicalFile(fileURLToPath(import.meta.url))
) {
  main();
}
