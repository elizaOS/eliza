#!/usr/bin/env node
/**
 * Anti-larp gate for focused and untraceably disabled JavaScript tests.
 *
 * AGENTS.md law #2 ("test everything for real — no larp") and #10718's
 * acceptance criteria require a gate that prevents two silent-larp regressions
 * that green CI otherwise hides:
 *
 *   1. FOCUSED tests — `describe.only` / `it.only` / `test.only` / `fit` /
 *      `fdescribe` / `suite.only` / `bench.only` / `context.only`. A single
 *      `.only` makes the runner drop every sibling test in the file, so a whole
 *      suite reports green while running one case. Zero tolerance — these must
 *      never reach `develop`.
 *
 *   2. ORPHANED skips — a hardcoded `it.skip("test name", fn)` / `.todo` / `xit`
 *      / `xdescribe` that is NOT traceable. A disabled test is acceptable only
 *      when its nearby window carries one of: a tracking ref (`#<number>`, an
 *      issue/PR URL, `TODO(#<number>)`, or a `.pr-deny-list.json` reference), a
 *      self-documenting reason (env/platform/dependency gate), or a Playwright
 *      skip `annotation` with a `description`. Runtime *conditional* skips
 *      (`cond ? describe : describe.skip`, `test.skip(!process.env.X, "…")`,
 *      or Node's documented `{ skip: process.platform !== "…" }` option) are
 *      allowed. A bare
 *      `it.skip("adds two numbers", fn)` — a real test name, no reason, no owner
 *      — is the orphaned case: a test that silently stopped running.
 *
 * The tree currently has ZERO of either (kept clean by discipline); this gate
 * makes that a build-enforced invariant so it cannot silently regress.
 *
 * Usage:
 *   node packages/scripts/audit-focused-skipped-tests.mjs             # CI gate
 *   node packages/scripts/audit-focused-skipped-tests.mjs --dry-run   # report only, exit 0
 *   node packages/scripts/audit-focused-skipped-tests.mjs --self-test # prove the gate works
 *
 * Exit codes: 0 clean, 1 violations found, 2 usage/internal error.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJsonSync,
  resolveReportArtifactPath,
} from "./lib/report-artifact-path.mjs";
import {
  assertContainedRegularFile,
  assertUniqueRepositoryIdentities,
  normalizeGitRepositoryPath,
} from "./lib/repository-file-integrity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const TEST_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const TEST_DIRECTORY_SEGMENTS = new Set([
  "__e2e__",
  "__tests__",
  "e2e",
  "spec",
  "specs",
  "test",
  "testing",
  "tests",
]);
const TEST_BASENAME_PATTERN =
  /(?:^|[._-])(?:e2e[._-])?(?:bench|benchmark|cy|test|spec)(?:[._-]|$)|(?:^|[._-])self-test(?:[._-]|$)/i;
const RUNNER_ROOTS = new Set([
  "bench",
  "context",
  "ctx",
  "describe",
  "it",
  "suite",
  "t",
  "test",
]);
const RUNTIME_SKIP_CONTEXTS = new Set(["ctx", "t"]);
const FOCUSED_ALIASES = new Set(["fdescribe", "fit"]);
const DISABLED_ALIASES = new Set(["xdescribe", "xit", "xtest"]);
const DISABLED_MODIFIERS = new Set([
  "fixme",
  "skip",
  "skipIf",
  "todo",
  "todoIf",
]);
const TEST_RUNNER_MODULES = new Set([
  "@jest/globals",
  "@playwright/test",
  "ava",
  "bun:test",
  "node:test",
  "node:test/promises",
  "vitest",
]);
export const TEST_SOURCE_EXCLUSIONS = new Map([]);

export function testSourceExclusionRecords(
  exclusions = TEST_SOURCE_EXCLUSIONS,
) {
  return [...exclusions].map(([file, reason]) => ({
    file,
    reason,
  }));
}

// A skip is compliant — traceable, not silently dropped (#10718) — when its
// title, arguments, attached comment, or same-line comment carries a tracking
// reference or explains the unavailable prerequisite.
// Both are legitimate: `it.skip("a", fn) // #1234` (tracked) and the far more
// common conditional/env-gate `it.skip("[live] requires OPENAI_API_KEY", fn)` /
// `test.skip(!process.env.X, "…")` / `it.skip("not on linux", fn)` (self-documenting).
// A bare `it.skip("adds two numbers", fn)` — a real test name with no reason and
// no ownership — is the orphaned case this gate catches.
// Tracking refs: a GitHub issue/PR, pending-work marker, or tracked-suppression file
// (`.pr-deny-list.json` / deny-list — the repo's ui-smoke suppression registry).
const TRACKING_REF =
  /#\d{2,}|github\.com\/[^\s)]+\/(?:issues|pull)\/\d+|TODO\s*\(\s*#?\d+|tracked?\b[^\n]*#?\d+|\bdeny-?list\b|pr-deny/i;
// Self-documenting-reason markers, incl. Playwright's official `annotation: {
// type: "skip", description: "…" }` form.
const REASON_MARKER =
  /\b(?:requires?|missing|unavailable|lacks?\b[^\n]*\baccess|not\s+(?:run|on|available|installed|supported|enabled|configured)|set\b[^\n]*\b(?:enable|run)|enable\b[^\n]*\b(?:test|suite|run)|only\s+(?:on|under|runs?)|not on PATH|process\.(?:platform|env)|os\.platform|isCI|un-?skip|once\b[^\n]*\blands?\b|until\b|blocked\s+(?:by|on)|no\s+[^\n]{1,80}\s+(?:available|installed|found|loaded|backend|store)|no shared)\b/i;
const RUNTIME_OPTION_REASON =
  /\b(?:process\.(?:platform|env|versions)|os\.platform|[A-Za-z_$][\w$]*(?:Platform|Runtime|Node\d*|Windows|Linux|Darwin|Available|Supported|Enabled|Configured|Installed)[\w$]*)\b/;

function normalizeRelativePath(value) {
  return normalizeGitRepositoryPath(value, "anti-larp test source");
}

function isTestSourcePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const extension = path.posix.extname(normalized).toLocaleLowerCase("en-US");
  if (!TEST_SOURCE_EXTENSIONS.has(extension)) return false;
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (TEST_BASENAME_PATTERN.test(basename)) return true;
  return segments
    .slice(0, -1)
    .some((segment) =>
      TEST_DIRECTORY_SEGMENTS.has(segment.toLocaleLowerCase("en-US")),
    );
}

function validateTestSourceExclusions(eligible, exclusions) {
  const eligibleSet = new Set(eligible);
  const normalizedExclusions = new Map();
  for (const [rawFile, rawReason] of exclusions) {
    const file = normalizeRelativePath(rawFile);
    const reason = String(rawReason).trim();
    if (!isTestSourcePath(file)) {
      throw new Error(
        `test-source exclusion is not an eligible source: ${file}`,
      );
    }
    if (!eligibleSet.has(file)) {
      throw new Error(
        `stale test-source exclusion does not match a repository file: ${file}`,
      );
    }
    if (reason.length < 12) {
      throw new Error(`test-source exclusion needs a durable reason: ${file}`);
    }
    const identity = file.toLocaleLowerCase("en-US");
    if (normalizedExclusions.has(identity)) {
      throw new Error(`duplicate test-source exclusion identity: ${file}`);
    }
    normalizedExclusions.set(identity, file);
  }
  return new Set(normalizedExclusions.values());
}

/** Discover every tracked or untracked non-ignored JavaScript test source. */
export function discoverTestSourceFiles(
  root = REPO_ROOT,
  candidateFiles,
  exclusions = candidateFiles === undefined
    ? TEST_SOURCE_EXCLUSIONS
    : new Map(),
) {
  const files =
    candidateFiles ??
    execFileSync(
      "git",
      [
        "-C",
        root,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
  const checkoutFiles =
    candidateFiles === undefined
      ? files.filter((file) => {
          // `git ls-files --cached` retains index entries deleted in the
          // worktree. Audit the executable checkout while leaving symlinks in
          // the inventory for the containment validator to reject below.
          try {
            const stat = fs.lstatSync(path.join(root, file));
            // Embedded untracked worktrees can make `git ls-files --others`
            // report a directory with a trailing slash. Directories are not
            // source candidates; retain symlinks so containment checks still
            // reject a symlinked test source or ancestor.
            return stat.isFile() || stat.isSymbolicLink();
          } catch (error) {
            if (error?.code === "ENOENT") return false;
            throw error;
          }
        })
      : files;
  const eligible = checkoutFiles
    .map(normalizeRelativePath)
    .filter(isTestSourcePath)
    .sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  assertUniqueRepositoryIdentities(
    eligible,
    "case-colliding or duplicate test source paths",
  );
  const excluded = validateTestSourceExclusions(eligible, exclusions);
  const discovered = eligible.filter(
    (relativePath) => !excluded.has(relativePath),
  );
  if (discovered.length === 0) {
    throw new Error(
      "test-file discovery returned zero JavaScript test sources",
    );
  }
  return discovered;
}

/** Load the complete test inventory or surface discovery/read failure. */
export function readTestSources(files, root = REPO_ROOT) {
  if (files.length === 0) {
    throw new Error(
      "test-file discovery returned zero JavaScript test sources",
    );
  }
  return files.map((rel) => {
    const source = assertContainedRegularFile(
      root,
      rel,
      `anti-larp test source ${rel}`,
    );
    return {
      rel,
      content: fs.readFileSync(source.absolute, "utf8"),
    };
  });
}

function scriptKind(filePath) {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function callChain(expression) {
  const current = unwrapExpression(expression);
  if (ts.isCallExpression(current)) return callChain(current.expression);
  if (ts.isIdentifier(current)) return [current.text];
  if (ts.isPropertyAccessExpression(current)) {
    const base = callChain(current.expression);
    return base ? [...base, current.name.text] : null;
  }
  if (ts.isElementAccessExpression(current)) {
    const base = callChain(current.expression);
    const key = current.argumentExpression;
    if (!base || !key || !ts.isStringLiteralLike(key)) return null;
    return [...base, key.text];
  }
  return null;
}

function bindingIdentifiers(name, identifiers = []) {
  if (ts.isIdentifier(name)) {
    identifiers.push(name);
  } else if (
    ts.isObjectBindingPattern(name) ||
    ts.isArrayBindingPattern(name)
  ) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        bindingIdentifiers(element.name, identifiers);
      }
    }
  }
  return identifiers;
}

function directScopeBindings(scope) {
  const bindings = new Map();
  const statements =
    ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : [];
  for (const statement of statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) bindings.set(clause.name.text, clause.name);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bindings.set(named.name.text, named.name);
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          bindings.set(element.name.text, element.name);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          bindings.set(identifier.text, identifier);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      bindings.set(statement.name.text, statement.name);
    }
  }
  return bindings;
}

function nearestBinding(identifier) {
  let current = identifier.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      const binding = directScopeBindings(current).get(identifier.text);
      if (binding) return binding;
    }
    if (ts.isFunctionLike(current)) {
      for (const parameter of current.parameters) {
        const binding = bindingIdentifiers(parameter.name).find(
          (candidate) => candidate.text === identifier.text,
        );
        if (binding) return binding;
      }
      if (
        (ts.isFunctionExpression(current) ||
          ts.isFunctionDeclaration(current)) &&
        current.name?.text === identifier.text
      ) {
        return current.name;
      }
    }
    if (ts.isCatchClause(current) && current.variableDeclaration) {
      const binding = bindingIdentifiers(current.variableDeclaration.name).find(
        (candidate) => candidate.text === identifier.text,
      );
      if (binding) return binding;
    }
    current = current.parent;
  }
  return undefined;
}

function baseIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (true) {
    if (
      ts.isCallExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
      current = unwrapExpression(current);
      continue;
    }
    break;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function resolvedAlias(expression, aliases) {
  const identifier = baseIdentifier(expression);
  if (!identifier) return undefined;
  const binding = nearestBinding(identifier);
  if (!binding) return undefined;
  const records = aliases.get(binding);
  if (!records) return undefined;
  const position = identifier.getStart();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].position <= position) return records[index];
  }
  return undefined;
}

function canonicalCallChain(expression, aliases) {
  const chain = callChain(expression);
  if (!chain) return null;
  const current = baseIdentifier(expression);
  if (!current) return null;
  const binding = nearestBinding(current);
  const alias = resolvedAlias(expression, aliases);
  if (alias) {
    return [...alias.chain, ...chain.slice(1)];
  }
  if (binding) return null;
  return chain;
}

function requireRunnerModule(expression) {
  const value = unwrapExpression(expression);
  if (
    !ts.isCallExpression(value) ||
    !ts.isIdentifier(value.expression) ||
    value.expression.text !== "require" ||
    value.arguments.length !== 1 ||
    !ts.isStringLiteralLike(value.arguments[0])
  ) {
    return false;
  }
  return TEST_RUNNER_MODULES.has(value.arguments[0].text);
}

function collectRunnerAliases(sourceFile) {
  const aliases = new Map();
  const addAlias = (
    declaration,
    chain,
    position,
    conditionalDisable = undefined,
  ) => {
    const records = aliases.get(declaration) ?? [];
    records.push({ chain, conditionalDisable, declaration, position });
    aliases.set(declaration, records);
  };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !TEST_RUNNER_MODULES.has(statement.moduleSpecifier.text) ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name) {
      addAlias(clause.name, ["test"], 0);
    }
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      addAlias(bindings.name, [], 0);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const imported = element.propertyName?.text ?? element.name.text;
        if (
          RUNNER_ROOTS.has(imported) ||
          FOCUSED_ALIASES.has(imported) ||
          DISABLED_ALIASES.has(imported)
        ) {
          addAlias(element.name, [imported], 0);
        }
      }
    }
  }

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const declaration = node;
      if (ts.isIdentifier(declaration.name)) {
        let chain;
        let conditionalDisable;
        if (requireRunnerModule(declaration.initializer)) {
          chain = ["test"];
        } else {
          chain = canonicalCallChain(declaration.initializer, aliases);
          const inherited = resolvedAlias(declaration.initializer, aliases);
          conditionalDisable = inherited?.conditionalDisable;
          const initializer = unwrapExpression(declaration.initializer);
          if (
            ts.isCallExpression(initializer) &&
            ["skipIf", "todoIf"].includes(chain?.at(-1))
          ) {
            conditionalDisable = {
              condition: initializer.arguments[0],
              node: initializer,
            };
          }
        }
        if (chain) {
          addAlias(
            declaration.name,
            chain,
            declaration.getEnd(),
            conditionalDisable,
          );
        }
      } else if (ts.isObjectBindingPattern(declaration.name)) {
        let base;
        if (requireRunnerModule(declaration.initializer)) {
          base = [];
        } else {
          base = canonicalCallChain(declaration.initializer, aliases);
        }
        if (base) {
          for (const element of declaration.name.elements) {
            if (
              element.dotDotDotToken ||
              !ts.isIdentifier(element.name) ||
              !(
                element.propertyName === undefined ||
                ts.isIdentifier(element.propertyName) ||
                ts.isStringLiteralLike(element.propertyName)
              )
            ) {
              continue;
            }
            const property = element.propertyName?.text ?? element.name.text;
            addAlias(element.name, [...base, property], declaration.getEnd());
          }
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = unwrapExpression(node.left);
      if (ts.isIdentifier(target)) {
        const declaration = nearestBinding(target);
        const chain = canonicalCallChain(node.right, aliases);
        if (declaration && chain) {
          let conditionalDisable;
          const initializer = unwrapExpression(node.right);
          if (
            ts.isCallExpression(initializer) &&
            ["skipIf", "todoIf"].includes(chain.at(-1))
          ) {
            conditionalDisable = {
              condition: initializer.arguments[0],
              node: initializer,
            };
          }
          addAlias(declaration, chain, node.getEnd(), conditionalDisable);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function disabledModifier(chain) {
  if (!chain) return null;
  if (chain.length === 1 && DISABLED_ALIASES.has(chain[0])) return "alias";
  if (!RUNNER_ROOTS.has(chain[0])) return null;
  return chain.find((part) => DISABLED_MODIFIERS.has(part)) ?? null;
}

function unwrapExpression(node) {
  let current = node;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      current = current.right;
      continue;
    }
    if (ts.isCommaListExpression(current)) {
      current = current.elements.at(-1);
      continue;
    }
    break;
  }
  return current;
}

const UNKNOWN_STATIC_VALUE = Symbol("unknown-static-value");

function staticPrimitive(node) {
  if (!node) return UNKNOWN_STATIC_VALUE;
  const value = unwrapExpression(node);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(value) && value.text === "undefined") return undefined;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isBigIntLiteral(value)) return BigInt(value.text.slice(0, -1));
  if (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.PlusToken ||
      value.operator === ts.SyntaxKind.MinusToken)
  ) {
    const operand = staticPrimitive(value.operand);
    if (typeof operand !== "number") return UNKNOWN_STATIC_VALUE;
    return value.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }
  return UNKNOWN_STATIC_VALUE;
}

const NODE_OPTION_RUN = "run";
const NODE_OPTION_SKIP = "skip";
const NODE_OPTION_CONDITIONAL = "conditional";
const NODE_OPTION_UNKNOWN = "unknown";

function nodeOptionFromPrimitive(value) {
  return value === false || value === undefined
    ? NODE_OPTION_RUN
    : NODE_OPTION_SKIP;
}

function knownNodeOptionSkipValue(node) {
  const value = unwrapExpression(node);
  if (
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isFunctionExpression(value) ||
    ts.isArrowFunction(value) ||
    ts.isClassExpression(value) ||
    ts.isNewExpression(value) ||
    ts.isRegularExpressionLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isTemplateExpression(value)
  ) {
    return true;
  }
  if (
    ts.isIdentifier(value) &&
    ["globalThis", "Infinity", "NaN"].includes(value.text)
  ) {
    return true;
  }
  const runtimeChain = trustedRuntimeCallChain(value);
  const chain = runtimeChain ?? callChain(value);
  if (
    runtimeChain?.join(".") === "os.platform" ||
    (chain?.length === 1 &&
      [
        "Array",
        "BigInt",
        "Date",
        "Function",
        "Number",
        "Object",
        "String",
        "Symbol",
      ].includes(chain[0]))
  ) {
    return true;
  }
  return knownTruthyRuntimeValue(value);
}

function knownOptionalRuntimeString(node) {
  const chain = trustedRuntimeCallChain(node);
  return (
    chain?.[0] === "process" &&
    chain.length === 3 &&
    (chain[1] === "env" || chain[1] === "versions")
  );
}

function immutablePriorVariableDeclaration(identifier) {
  const sourceFile = identifier.getSourceFile();
  const identifierStart = identifier.getStart(sourceFile);
  const binding = nearestBinding(identifier);
  if (!binding || !ts.isVariableDeclaration(binding.parent)) return undefined;
  const declaration = binding.parent;
  if (
    declaration.name !== binding ||
    !declaration.initializer ||
    declaration.getEnd() > identifierStart
  ) {
    return undefined;
  }
  const declarationList = declaration.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    !(declarationList.flags & ts.NodeFlags.Const)
  ) {
    return undefined;
  }
  return declaration;
}

function trustedNodeOsIdentifier(identifier) {
  const binding = nearestBinding(identifier);
  if (!binding) return false;

  let current = binding.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) {
      return (
        ts.isStringLiteralLike(current.moduleSpecifier) &&
        current.moduleSpecifier.text === "node:os" &&
        (current.importClause?.name === binding ||
          (ts.isNamespaceImport(binding.parent) &&
            binding.parent.name === binding))
      );
    }
    current = current.parent;
  }

  const declaration = immutablePriorVariableDeclaration(identifier);
  if (!declaration) return false;
  const initializer = unwrapExpression(declaration.initializer);
  return (
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "require" &&
    nearestBinding(initializer.expression) === undefined &&
    initializer.arguments.length === 1 &&
    ts.isStringLiteralLike(initializer.arguments[0]) &&
    initializer.arguments[0].text === "node:os"
  );
}

function trustedRuntimeCallChain(node) {
  const chain = callChain(node);
  if (!chain) return null;
  const root = baseIdentifier(node);
  if (!root) return null;
  if (chain[0] === "process") {
    return nearestBinding(root) === undefined ? chain : null;
  }
  if (chain[0] === "os") {
    return trustedNodeOsIdentifier(root) ? chain : null;
  }
  return null;
}

function recognizedRuntimeSignal(node, seenDeclarations = new Set()) {
  const value = unwrapExpression(node);
  if (ts.isIdentifier(value)) {
    const declaration = immutablePriorVariableDeclaration(value);
    if (!declaration || seenDeclarations.has(declaration)) return false;
    const nextSeen = new Set(seenDeclarations);
    nextSeen.add(declaration);
    return recognizedRuntimeSignal(declaration.initializer, nextSeen);
  }
  if (
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value)
  ) {
    const chain = trustedRuntimeCallChain(value);
    return (
      chain?.[0] === "process" &&
      (chain[1] === "platform" ||
        (chain.length >= 3 && (chain[1] === "env" || chain[1] === "versions")))
    );
  }
  if (ts.isPrefixUnaryExpression(value)) {
    return recognizedRuntimeSignal(value.operand, seenDeclarations);
  }
  if (ts.isBinaryExpression(value)) {
    return (
      recognizedRuntimeSignal(value.left, seenDeclarations) ||
      recognizedRuntimeSignal(value.right, seenDeclarations)
    );
  }
  if (ts.isConditionalExpression(value)) {
    return recognizedRuntimeSignal(value.condition, seenDeclarations);
  }
  if (ts.isCallExpression(value)) {
    const chain = trustedRuntimeCallChain(value.expression);
    return chain?.join(".") === "os.platform";
  }
  return false;
}

/**
 * Classify Node's `test(name, { skip }, fn)` option by Node semantics.
 * Unlike skipIf/focus truthiness, Node runs only for exact false/undefined;
 * every other value is a skip reason, including 0, an empty string, null,
 * objects, functions, and known runtime strings such as os.platform().
 */
function nodeOptionDisposition(node) {
  if (!node) return NODE_OPTION_UNKNOWN;
  const value = unwrapExpression(node);
  const primitive = staticPrimitive(value);
  if (primitive !== UNKNOWN_STATIC_VALUE) {
    return nodeOptionFromPrimitive(primitive);
  }
  if (knownNodeOptionSkipValue(value)) return NODE_OPTION_SKIP;
  if (ts.isVoidExpression(value)) return NODE_OPTION_RUN;
  if (
    ts.isTypeOfExpression(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.TildeToken,
      ].includes(value.operator))
  ) {
    return NODE_OPTION_SKIP;
  }
  if (ts.isPrefixUnaryExpression(value)) {
    if (value.operator === ts.SyntaxKind.ExclamationToken) {
      const truthy = staticTruthiness(value.operand);
      return truthy === undefined
        ? recognizedRuntimeSignal(value.operand)
          ? NODE_OPTION_CONDITIONAL
          : NODE_OPTION_UNKNOWN
        : nodeOptionFromPrimitive(!truthy);
    }
  }
  if (ts.isDeleteExpression(value)) return NODE_OPTION_UNKNOWN;
  if (ts.isConditionalExpression(value)) {
    const condition = staticTruthiness(value.condition);
    if (condition === true) return nodeOptionDisposition(value.whenTrue);
    if (condition === false) return nodeOptionDisposition(value.whenFalse);
    const whenTrue = nodeOptionDisposition(value.whenTrue);
    const whenFalse = nodeOptionDisposition(value.whenFalse);
    if (whenTrue === whenFalse) return whenTrue;
    return recognizedRuntimeSignal(value.condition)
      ? NODE_OPTION_CONDITIONAL
      : NODE_OPTION_UNKNOWN;
  }
  if (ts.isBinaryExpression(value)) {
    if (value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return nodeOptionDisposition(value.right);
    }
    if (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = staticPrimitive(value.left);
      if (left !== UNKNOWN_STATIC_VALUE) {
        return left === null || left === undefined
          ? nodeOptionDisposition(value.right)
          : nodeOptionFromPrimitive(left);
      }
      if (knownNodeOptionSkipValue(value.left)) return NODE_OPTION_SKIP;
      if (knownOptionalRuntimeString(value.left)) {
        return nodeOptionDisposition(value.right) === NODE_OPTION_SKIP
          ? NODE_OPTION_SKIP
          : NODE_OPTION_CONDITIONAL;
      }
      return NODE_OPTION_UNKNOWN;
    }
    if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = staticTruthiness(value.left);
      if (left === false) return nodeOptionDisposition(value.left);
      if (left === true) return nodeOptionDisposition(value.right);
      return recognizedRuntimeSignal(value.left)
        ? NODE_OPTION_CONDITIONAL
        : NODE_OPTION_UNKNOWN;
    }
    if (value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const left = staticTruthiness(value.left);
      if (left === true) return nodeOptionDisposition(value.left);
      if (left === false) return nodeOptionDisposition(value.right);
      return nodeOptionDisposition(value.right) === NODE_OPTION_SKIP
        ? NODE_OPTION_SKIP
        : recognizedRuntimeSignal(value.left)
          ? NODE_OPTION_CONDITIONAL
          : NODE_OPTION_UNKNOWN;
    }
    const comparison = staticComparison(value);
    if (comparison !== undefined) return nodeOptionFromPrimitive(comparison);
    if (
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.InKeyword,
        ts.SyntaxKind.InstanceOfKeyword,
      ].includes(value.operatorToken.kind)
    ) {
      return recognizedRuntimeSignal(value)
        ? NODE_OPTION_CONDITIONAL
        : NODE_OPTION_UNKNOWN;
    }
    if (
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ].includes(value.operatorToken.kind)
    ) {
      return NODE_OPTION_SKIP;
    }
  }
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "Boolean"
  ) {
    const firstArgument = value.arguments[0];
    if (!firstArgument) return NODE_OPTION_RUN;
    const truthy = staticTruthiness(firstArgument);
    return truthy === undefined
      ? recognizedRuntimeSignal(firstArgument)
        ? NODE_OPTION_CONDITIONAL
        : NODE_OPTION_UNKNOWN
      : nodeOptionFromPrimitive(truthy);
  }
  return recognizedRuntimeSignal(value)
    ? NODE_OPTION_CONDITIONAL
    : NODE_OPTION_UNKNOWN;
}

function staticComparison(node) {
  if (!ts.isBinaryExpression(node)) return undefined;
  const left = staticPrimitive(node.left);
  const right = staticPrimitive(node.right);
  if (left === UNKNOWN_STATIC_VALUE || right === UNKNOWN_STATIC_VALUE) {
    return undefined;
  }
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return left === right;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return left !== right;
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken: {
      const comparable =
        typeof left === typeof right ||
        ((left === null || left === undefined) &&
          (right === null || right === undefined));
      if (!comparable) return undefined;
      const equal =
        left === right ||
        (left === null && right === undefined) ||
        (left === undefined && right === null);
      return node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
        ? equal
        : !equal;
    }
    case ts.SyntaxKind.LessThanToken:
      return left < right;
    case ts.SyntaxKind.LessThanEqualsToken:
      return left <= right;
    case ts.SyntaxKind.GreaterThanToken:
      return left > right;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return left >= right;
    default:
      return undefined;
  }
}

function knownTruthyRuntimeValue(node) {
  const chain = trustedRuntimeCallChain(node);
  return (
    chain?.join(".") === "os.platform" ||
    (chain?.[0] === "process" &&
      ((chain.length === 2 &&
        (chain[1] === "env" ||
          chain[1] === "platform" ||
          chain[1] === "versions")) ||
        (chain.length === 3 && chain[1] === "versions" && chain[2] === "node")))
  );
}

function knownTruthyObjectValue(node) {
  const value = unwrapExpression(node);
  return (
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    ts.isFunctionExpression(value) ||
    ts.isArrowFunction(value) ||
    ts.isClassExpression(value) ||
    ts.isNewExpression(value) ||
    ts.isRegularExpressionLiteral(value)
  );
}

function staticTruthiness(node) {
  if (!node) return undefined;
  const value = unwrapExpression(node);
  const primitive = staticPrimitive(value);
  if (primitive !== UNKNOWN_STATIC_VALUE) return Boolean(primitive);
  if (knownTruthyRuntimeValue(value) || knownTruthyObjectValue(value)) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(value)) {
    if (value.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = staticTruthiness(value.operand);
      return operand === undefined ? undefined : !operand;
    }
  }
  if (ts.isConditionalExpression(value)) {
    const condition = staticTruthiness(value.condition);
    if (condition === true) return staticTruthiness(value.whenTrue);
    if (condition === false) return staticTruthiness(value.whenFalse);
    const whenTrue = staticTruthiness(value.whenTrue);
    const whenFalse = staticTruthiness(value.whenFalse);
    return whenTrue === whenFalse ? whenTrue : undefined;
  }
  if (ts.isBinaryExpression(value)) {
    if (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = staticPrimitive(value.left);
      if (left !== UNKNOWN_STATIC_VALUE) {
        return left === null || left === undefined
          ? staticTruthiness(value.right)
          : Boolean(left);
      }
      return undefined;
    }
    if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = staticTruthiness(value.left);
      if (left === false) return false;
      const right = staticTruthiness(value.right);
      if (left === true) return right;
      return right === false ? false : undefined;
    }
    if (value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const left = staticTruthiness(value.left);
      if (left === true) return true;
      const right = staticTruthiness(value.right);
      if (left === false) return right;
      return right === true ? true : undefined;
    }
    return staticComparison(value);
  }
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "Boolean" &&
    value.arguments.length === 1
  ) {
    return staticTruthiness(value.arguments[0]);
  }
  return undefined;
}

function findModifierCall(node, modifier, aliases) {
  let current = node;
  while (current) {
    const unwrapped = unwrapExpression(current);
    if (!ts.isCallExpression(unwrapped)) return null;
    const chain = canonicalCallChain(unwrapped.expression, aliases);
    if (
      !ts.isCallExpression(unwrapExpression(unwrapped.expression)) &&
      chain?.at(-1) === modifier
    ) {
      return unwrapped;
    }
    current = unwrapped.expression;
  }
  return null;
}

function hasOuterModifierCall(node, modifier, sourceFile, aliases) {
  const start = node.getStart(sourceFile);
  let parent = node.parent;
  while (parent && parent.getStart(sourceFile) === start) {
    if (
      ts.isCallExpression(parent) &&
      disabledModifier(canonicalCallChain(parent.expression, aliases)) ===
        modifier
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function hasOuterFocusedCall(node, sourceFile, aliases) {
  const start = node.getStart(sourceFile);
  let parent = node.parent;
  while (parent && parent.getStart(sourceFile) === start) {
    if (
      ts.isCallExpression(parent) &&
      isFocusedChain(canonicalCallChain(parent.expression, aliases))
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function classifiedOptionCalls(node, sourceFile) {
  const options = [];
  for (const argument of node.arguments) {
    const value = unwrapExpression(argument);
    if (!ts.isObjectLiteralExpression(value)) continue;
    for (const property of value.properties) {
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === "only"
      ) {
        options.push({ modifier: "only", documented: false });
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) ||
        !(
          ts.isIdentifier(property.name) ||
          ts.isStringLiteralLike(property.name)
        )
      ) {
        continue;
      }
      if (!["only", "skip", "todo"].includes(property.name.text)) continue;
      const truthy = staticTruthiness(property.initializer);
      const skipDisposition =
        property.name.text === "skip"
          ? nodeOptionDisposition(property.initializer)
          : undefined;
      if (
        (property.name.text === "only" && truthy !== false) ||
        (property.name.text !== "only" &&
          (truthy === true ||
            (property.name.text === "skip" &&
              skipDisposition !== NODE_OPTION_RUN)))
      ) {
        const reason = unwrapExpression(property.initializer);
        const propertyEvidence = sourceFile.text.slice(
          property.getFullStart(),
          property.getEnd(),
        );
        const conditional =
          property.name.text === "skip"
            ? skipDisposition === NODE_OPTION_CONDITIONAL
            : truthy === undefined;
        options.push({
          modifier: property.name.text,
          conditional,
          documented:
            (ts.isStringLiteralLike(reason) &&
              reason.text.trim().length >= 8) ||
            TRACKING_REF.test(propertyEvidence) ||
            REASON_MARKER.test(propertyEvidence) ||
            (conditional &&
              RUNTIME_OPTION_REASON.test(
                property.initializer.getText(sourceFile),
              )),
        });
      }
    }
  }
  return options;
}

function annotationDescriptions(argument) {
  if (!ts.isObjectLiteralExpression(unwrapExpression(argument))) return [];
  const descriptions = [];
  const visitObject = (object) => {
    for (const property of object.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(
          ts.isIdentifier(property.name) ||
          ts.isStringLiteralLike(property.name)
        )
      ) {
        continue;
      }
      if (property.name.text === "description") {
        const value = unwrapExpression(property.initializer);
        if (ts.isStringLiteralLike(value) && value.text.trim()) {
          descriptions.push(value.text);
        }
      } else if (property.name.text === "annotation") {
        const value = unwrapExpression(property.initializer);
        if (ts.isObjectLiteralExpression(value)) visitObject(value);
      }
    }
  };
  visitObject(unwrapExpression(argument));
  return descriptions;
}

function evidenceText(sourceFile, node) {
  const source = sourceFile.text;
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const lineEnd = source.indexOf("\n", end);
  const evidence = [
    source.slice(node.getFullStart(), start),
    source.slice(end, lineEnd === -1 ? source.length : lineEnd),
  ];
  for (const argument of node.arguments) {
    const value = unwrapExpression(argument);
    if (
      ts.isStringLiteralLike(value) ||
      ts.isTemplateExpression(value) ||
      ts.isNoSubstitutionTemplateLiteral(value)
    ) {
      evidence.push(source.slice(argument.getFullStart(), argument.getEnd()));
    } else {
      evidence.push(
        source.slice(argument.getFullStart(), argument.getStart(sourceFile)),
      );
      evidence.push(...annotationDescriptions(value));
    }
  }
  return evidence.join("\n");
}

function lineText(sourceFile, node) {
  const start = node.getStart(sourceFile);
  const lineStart = sourceFile.text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = sourceFile.text.indexOf("\n", start);
  return sourceFile.text
    .slice(lineStart, lineEnd === -1 ? sourceFile.text.length : lineEnd)
    .trim()
    .slice(0, 120);
}

function isFocusedChain(chain) {
  if (!chain) return false;
  if (chain.length === 1) return FOCUSED_ALIASES.has(chain[0]);
  return RUNNER_ROOTS.has(chain[0]) && chain.slice(1).includes("only");
}

function hasDocumentedDisable(sourceFile, node) {
  if (
    node.arguments.some(
      (argument) => annotationDescriptions(argument).length > 0,
    )
  ) {
    return true;
  }
  const evidence = evidenceText(sourceFile, node);
  return TRACKING_REF.test(evidence) || REASON_MARKER.test(evidence);
}

function isConditionalDisableDocumented(sourceFile, node) {
  const description = node.arguments[1];
  const unwrapped = description && unwrapExpression(description);
  if (unwrapped && ts.isStringLiteralLike(unwrapped)) {
    return unwrapped.text.trim().length >= 8;
  }
  if (
    unwrapped &&
    unwrapped.kind !== ts.SyntaxKind.NullKeyword &&
    !(ts.isIdentifier(unwrapped) && unwrapped.text === "undefined")
  ) {
    return true;
  }
  return hasDocumentedDisable(sourceFile, node);
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {{file:string,line:number,kind:'focused'|'orphaned-skip',text:string}[]}
 */
export function findViolations(filePath, content) {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    throw new Error(
      `${filePath}:${diagnostic.start ?? 0} could not be parsed: ${message}`,
    );
  }

  const aliases = collectRunnerAliases(sourceFile);
  const conditionalAliasInitializers = new Set(
    [...aliases.values()]
      .flatMap((records) =>
        records.map((alias) => alias.conditionalDisable?.node),
      )
      .filter(Boolean),
  );
  const violations = [];
  const recorded = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && !conditionalAliasInitializers.has(node)) {
      const chain = canonicalCallChain(node.expression, aliases);
      const alias = resolvedAlias(node.expression, aliases);
      const optionCalls =
        chain && RUNNER_ROOTS.has(chain[0]) && RUNNER_ROOTS.has(chain.at(-1))
          ? classifiedOptionCalls(node, sourceFile)
          : [];
      const position = node.getStart(sourceFile);
      if (
        (isFocusedChain(chain) ||
          optionCalls.some(({ modifier }) => modifier === "only")) &&
        !hasOuterFocusedCall(node, sourceFile, aliases)
      ) {
        const key = `focused:${position}`;
        if (!recorded.has(key)) {
          recorded.add(key);
          const { line } = sourceFile.getLineAndCharacterOfPosition(position);
          violations.push({
            file: filePath,
            line: line + 1,
            kind: "focused",
            text: lineText(sourceFile, node),
          });
        }
      } else {
        const optionDisable = optionCalls.find(({ modifier }) =>
          ["skip", "todo"].includes(modifier),
        );
        const modifier = disabledModifier(chain) ?? optionDisable?.modifier;
        let documented = true;
        if (
          modifier &&
          hasOuterModifierCall(node, modifier, sourceFile, aliases)
        ) {
          documented = true;
        } else if (modifier === "skipIf" || modifier === "todoIf") {
          const modifierCall = alias?.conditionalDisable
            ? alias.conditionalDisable.node
            : findModifierCall(node, modifier, aliases);
          const condition = alias?.conditionalDisable
            ? alias.conditionalDisable.condition
            : modifierCall?.arguments[0];
          documented =
            !modifierCall ||
            staticTruthiness(condition) !== true ||
            hasDocumentedDisable(sourceFile, node) ||
            (alias?.conditionalDisable
              ? hasDocumentedDisable(sourceFile, alias.conditionalDisable.node)
              : false);
        } else if (optionDisable) {
          documented =
            optionDisable.documented || hasDocumentedDisable(sourceFile, node);
        } else if (modifier === "skip" || modifier === "fixme") {
          const firstArgument = node.arguments[0];
          const firstValue = firstArgument && unwrapExpression(firstArgument);
          if (
            chain &&
            RUNTIME_SKIP_CONTEXTS.has(chain[0]) &&
            firstValue &&
            ts.isStringLiteralLike(firstValue)
          ) {
            documented = firstValue.text.trim().length >= 8;
          } else {
            documented =
              firstValue && !ts.isStringLiteralLike(firstValue)
                ? isConditionalDisableDocumented(sourceFile, node)
                : hasDocumentedDisable(sourceFile, node);
          }
        } else if (modifier === "todo" || modifier === "alias") {
          documented = hasDocumentedDisable(sourceFile, node);
        }
        if (modifier && !documented) {
          const key = `orphaned-skip:${position}`;
          if (!recorded.has(key)) {
            recorded.add(key);
            const { line } = sourceFile.getLineAndCharacterOfPosition(position);
            violations.push({
              file: filePath,
              line: line + 1,
              kind: "orphaned-skip",
              text: lineText(sourceFile, node),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/**
 * Find every allowed runtime-conditional skip site in one test source.
 *
 * A site is runtime-conditional when whether the test skips is decided at run
 * time, not in the source text: a runner ternary (`cond ? describe :
 * describe.skip`), a `skipIf`/`todoIf` whose condition is not statically
 * decidable, a `skip`/`fixme` whose first argument is a non-literal,
 * non-function condition, or a documented dynamic `skip` property in a runner
 * options object. Unconditional skips — even documented ones — are never
 * returned, and a file with any gate violation yields zero sites, so consumers
 * (the script-lane JUnit evidence gate) cannot bless a file the anti-larp gate
 * itself rejects. Throws on unparseable input.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {{file:string,line:number,form:string,text:string}[]}
 */
export function findConditionalSkipSites(filePath, content) {
  if (findViolations(filePath, content).length > 0) return [];
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const aliases = collectRunnerAliases(sourceFile);
  const sites = [];
  const recorded = new Set();
  const record = (node, form) => {
    const position = node.getStart(sourceFile);
    if (recorded.has(position)) return;
    recorded.add(position);
    const { line } = sourceFile.getLineAndCharacterOfPosition(position);
    sites.push({
      file: filePath,
      line: line + 1,
      form,
      text: lineText(sourceFile, node),
    });
  };
  const isRunnerReference = (chain) =>
    chain !== null &&
    chain !== undefined &&
    (RUNNER_ROOTS.has(chain[0]) ||
      (chain.length === 1 &&
        (DISABLED_ALIASES.has(chain[0]) || FOCUSED_ALIASES.has(chain[0]))));
  const visit = (node) => {
    if (
      ts.isConditionalExpression(node) &&
      staticTruthiness(node.condition) === undefined
    ) {
      const branches = [node.whenTrue, node.whenFalse].map((branch) =>
        canonicalCallChain(branch, aliases),
      );
      if (
        branches.every(isRunnerReference) &&
        (disabledModifier(branches[0]) !== null) !==
          (disabledModifier(branches[1]) !== null)
      ) {
        record(node, "conditional-runner-ternary");
      }
    }
    if (ts.isCallExpression(node)) {
      const chain = canonicalCallChain(node.expression, aliases);
      const modifier = disabledModifier(chain);
      if (modifier === "skipIf" || modifier === "todoIf") {
        const alias = resolvedAlias(node.expression, aliases);
        const modifierCall = alias?.conditionalDisable
          ? alias.conditionalDisable.node
          : findModifierCall(node, modifier, aliases);
        const condition = alias?.conditionalDisable
          ? alias.conditionalDisable.condition
          : modifierCall?.arguments[0];
        if (condition && staticTruthiness(condition) === undefined) {
          record(modifierCall ?? node, modifier);
        }
      } else if (modifier === "skip" || modifier === "fixme") {
        const firstArgument = node.arguments[0];
        const firstValue = firstArgument && unwrapExpression(firstArgument);
        if (
          firstValue &&
          !ts.isStringLiteralLike(firstValue) &&
          !ts.isFunctionLike(firstValue) &&
          staticTruthiness(firstValue) === undefined
        ) {
          record(node, `conditional-${modifier}`);
        }
      } else if (
        chain &&
        RUNNER_ROOTS.has(chain[0]) &&
        RUNNER_ROOTS.has(chain.at(-1))
      ) {
        const conditionalOption = classifiedOptionCalls(node, sourceFile).find(
          ({ modifier: optionModifier, conditional }) =>
            optionModifier === "skip" && conditional,
        );
        if (conditionalOption) {
          record(node, "conditional-option-skip");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/**
 * Return the subset of repo-relative test files that carry at least one
 * allowed runtime-conditional skip site. This is the single classifier the
 * script-lane JUnit evidence gate binds to: only files in this set may report
 * skipped testcases. Fail-closed — unreadable or unparseable sources throw
 * rather than classifying as skip-free.
 *
 * @param {string[]} files repo-relative test source paths
 * @param {string} [root]
 * @returns {Set<string>}
 */
export function conditionalSkipBearingFiles(files, root = REPO_ROOT) {
  const bearing = new Set();
  if (files.length === 0) return bearing;
  const normalized = files.map(normalizeRelativePath);
  for (const { rel, content } of readTestSources(normalized, root)) {
    if (findConditionalSkipSites(rel, content).length > 0) {
      bearing.add(rel);
    }
  }
  return bearing;
}

function writeInventoryReport(report) {
  const output = resolveReportArtifactPath(
    REPO_ROOT,
    "reports/test-source-inventory.json",
    {
      extension: ".json",
      label: "test-source inventory report",
    },
  ).absolute;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  atomicWriteJsonSync(output, report);
}

function runGate({ dryRun, json }) {
  const files = discoverTestSourceFiles();
  /** @type {ReturnType<typeof findViolations>} */
  const all = [];
  for (const { rel, content } of readTestSources(files)) {
    all.push(...findViolations(rel, content));
  }

  const focused = all.filter((v) => v.kind === "focused");
  const orphaned = all.filter((v) => v.kind === "orphaned-skip");
  const report = {
    schemaVersion: 1,
    discoveredCount: files.length,
    excludedCount: TEST_SOURCE_EXCLUSIONS.size,
    focusedCount: focused.length,
    orphanedSkipCount: orphaned.length,
    files,
    excluded: testSourceExclusionRecords(),
    violations: all,
  };
  writeInventoryReport(report);

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(
      `[anti-larp] scanned ${files.length} test files — ${focused.length} focused, ${orphaned.length} orphaned skip(s)`,
    );
  }

  if (all.length === 0) {
    if (!json) {
      console.log("[anti-larp] clean — no focused tests, no untracked skips.");
    }
    return 0;
  }

  if (focused.length > 0) {
    console.error(
      `\n✗ ${focused.length} FOCUSED test(s) — a single .only silently drops every sibling test:`,
    );
    for (const v of focused) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error(
      "  Remove the .only / fit / fdescribe so the whole suite runs.",
    );
  }
  if (orphaned.length > 0) {
    console.error(
      `\n✗ ${orphaned.length} ORPHANED skip(s) — a disabled test with no tracking issue:`,
    );
    for (const v of orphaned) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error(
      "  Re-enable + fix, delete with a reason, or add a tracking ref (e.g. `// skip: #1234`).",
    );
  }

  if (dryRun) {
    console.error("\n[anti-larp] --dry-run: not failing.");
    return 0;
  }
  return 1;
}

function selfTest() {
  const cases = [
    {
      name: "flags describe.only",
      src: 'describe.only("x", () => { it("a", () => {}); });',
      expect: ["focused"],
    },
    {
      name: "flags it.only",
      src: 'it.only("a", () => {});',
      expect: ["focused"],
    },
    {
      name: "flags it.only.each",
      src: "it.only.each([1])('a', () => {});",
      expect: ["focused"],
    },
    {
      name: "flags multiline and bracket focused syntax",
      src: 'test\n  ["only"]\n  ("a", () => {});',
      expect: ["focused"],
    },
    {
      name: "flags nested Playwright describe focus",
      src: 'test.describe.only("a", () => {});',
      expect: ["focused"],
    },
    { name: "flags fit(", src: 'fit("a", () => {});', expect: ["focused"] },
    {
      name: "flags fdescribe(",
      src: 'fdescribe("a", () => {});',
      expect: ["focused"],
    },
    {
      name: "flags bare orphaned it.skip (test name only, no reason/ref)",
      src: 'it.skip("adds two numbers", () => {});',
      expect: ["orphaned-skip"],
    },
    {
      name: "flags orphaned xit(",
      src: 'xit("does a thing", () => {});',
      expect: ["orphaned-skip"],
    },
    {
      name: "flags orphaned xtest(",
      src: 'xtest("does a thing", () => {});',
      expect: ["orphaned-skip"],
    },
    {
      name: "flags nested Playwright describe skip",
      src: 'test.describe.skip("does a thing", () => {});',
      expect: ["orphaned-skip"],
    },
    {
      name: "allows conditional-runner ternary (env-gated real test)",
      src: "const suite = ptyAvailable ? describe : describe.skip;\nsuite('pty', () => {});",
      expect: [],
    },
    {
      name: "allows self-documenting live env-gate skip",
      src: 'it.skip("[live] requires OPENAI_API_KEY", () => {});',
      expect: [],
    },
    {
      name: "allows platform-gated skip with reason",
      src: 'it.skip("not on linux", () => {});',
      expect: [],
    },
    {
      name: "allows Playwright conditional test.skip(cond, reason)",
      src: 'test.skip(\n  !process.env.RUN_CLOUD_E2E,\n  "set RUN_CLOUD_E2E to run",\n);',
      expect: [],
    },
    {
      name: "allows conditional skip with non-marker reason (first arg not a string)",
      src: 'test.skip(!healthy, "Server is not healthy");',
      expect: [],
    },
    {
      name: "allows Playwright annotation-documented skip",
      src: 'test.skip("two clients converge", {\n  annotation: { type: "skip", description: "no shared store backend" },\n}, async () => {});',
      expect: [],
    },
    {
      name: "allows skip referencing the deny-list suppression file",
      src: '// tracked on ui-smoke .pr-deny-list.json\nit.skip("flow X", () => {});',
      expect: [],
    },
    {
      name: "allows skip with #issue ref on same line",
      src: 'it.skip("a", () => {}); // flaky, tracked in #1234',
      expect: [],
    },
    {
      name: "allows skip with tracking comment above",
      src: '// skip: blocked on #9999\nit.skip("a", () => {});',
      expect: [],
    },
    {
      name: "allows skip with TODO(#n)",
      src: 'describe.skip("a", () => {}); // TODO(#4321) re-enable',
      expect: [],
    },
    {
      name: "ignores it.only inside a comment",
      src: '// do not use it.only here\nit("a", () => {});',
      expect: [],
    },
    {
      name: "ignores unrelated .only property",
      src: 'const readonly = { only: true }; it("a", () => { expect(cfg.only).toBe(true); });',
      expect: [],
    },
    {
      name: "ignores a runner-name.only inside a string literal (page id, etc.)",
      src: 'const sample = "test.only("; registerAppShellPage({ id: "test.only", label: "Solo" });\nit("a", () => {});',
      expect: [],
    },
    {
      name: "clean file passes",
      src: 'describe("x", () => { it("a", () => { expect(1).toBe(1); }); });',
      expect: [],
    },
  ];

  // The JUnit evidence gate in run-script-tests.mjs binds skipped counts to
  // this classification; these cases pin which shapes bless a file and which
  // (documented-but-unconditional, orphaned) never do.
  const conditionalCases = [
    {
      name: "conditional: runner ternary is a runtime-conditional site",
      src: "const suite = gnuSedAvailable ? describe : describe.skip;\nsuite('pty', () => {});",
      expect: ["conditional-runner-ternary"],
    },
    {
      name: "conditional: skip(cond, reason) is a runtime-conditional site",
      src: 'test.skip(!process.env.RUN_CLOUD_E2E, "set RUN_CLOUD_E2E to run");',
      expect: ["conditional-skip"],
    },
    {
      name: "conditional: skipIf with a runtime condition is a site",
      src: 'describe.skipIf(!hasBackend)("store", () => {});',
      expect: ["skipIf"],
    },
    {
      name: "conditional: documented Node option skip is a site",
      src: 'test("Windows contract", { skip: process.platform !== "win32" ? "Windows contract" : false }, () => {});',
      expect: ["conditional-option-skip"],
    },
    {
      name: "conditional: undocumented Node option skip does not bless",
      src: 'test("ordinary title", { skip: shouldSkip }, () => {});',
      expect: [],
    },
    {
      name: "conditional: non-runner option skip is ignored",
      src: 'customRunner("x", { skip: process.platform !== "win32" ? "Windows contract" : false });',
      expect: [],
    },
    {
      name: "conditional: same-branch option skip is statically truthy",
      src: 'test("x", { skip: process.platform === "win32" ? true : true }, () => {});',
      expect: [],
    },
    {
      name: "conditional: logical option dominance stays static",
      src: 'test("x", { skip: true || process.platform === "win32" }, () => {});',
      expect: [],
    },
    {
      name: "conditional: literal comparison option stays static",
      src: 'test("x", { /* requires Windows */ skip: 1 === 1 }, () => {});',
      expect: [],
    },
    {
      name: "conditional: bare platform value is always truthy",
      src: 'test("x", { skip: process.platform }, () => {});',
      expect: [],
    },
    {
      name: "conditional: statically-true skipIf is not runtime-conditional",
      src: 'describe.skipIf(true)("store", () => {}); // skip: #1234',
      expect: [],
    },
    {
      name: "conditional: documented unconditional skip does not bless",
      src: 'it.skip("[live] requires OPENAI_API_KEY", () => {});',
      expect: [],
    },
    {
      name: "conditional: a violating file yields zero sites",
      src: 'const suite = cond ? describe : describe.skip;\nsuite("a", () => {});\nit.skip("adds two numbers", () => {});',
      expect: [],
    },
    {
      name: "conditional: non-runner ternary is ignored",
      src: 'const value = cond ? left : right;\nit("a", () => {});',
      expect: [],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = findViolations("<fixture>", c.src)
      .map((v) => v.kind)
      .sort();
    const want = [...c.expect].sort();
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
      failed++;
      console.error(
        `  ✗ ${c.name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }
  for (const c of conditionalCases) {
    const got = findConditionalSkipSites("<fixture>", c.src)
      .map((site) => site.form)
      .sort();
    const want = [...c.expect].sort();
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
      failed++;
      console.error(
        `  ✗ ${c.name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }
  const total = cases.length + conditionalCases.length;
  if (failed > 0) {
    console.error(`\nself-test FAILED (${failed}/${total})`);
    return 1;
  }
  console.log(`\nself-test PASSED (${total}/${total})`);
  return 0;
}

export function parseFocusedAuditArgs(args) {
  const supported = new Set([
    "--dry-run",
    "--help",
    "-h",
    "--json",
    "--self-test",
  ]);
  for (const arg of args) {
    if (!supported.has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (new Set(args).size !== args.length) {
    throw new Error("arguments may be specified only once");
  }
  const helpFlags = args.filter((arg) => arg === "--help" || arg === "-h");
  if (helpFlags.length > 1) {
    throw new Error("help may be specified only once");
  }
  if (helpFlags.length === 1 && args.length !== 1) {
    throw new Error("help cannot be combined with audit arguments");
  }
  if (
    args.includes("--self-test") &&
    (args.includes("--dry-run") || args.includes("--json"))
  ) {
    throw new Error("--self-test cannot be combined with --dry-run or --json");
  }
  return {
    dryRun: args.includes("--dry-run"),
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
    selfTest: args.includes("--self-test"),
  };
}

function printUsage() {
  process.stdout.write(
    "Usage: node packages/scripts/audit-focused-skipped-tests.mjs [--dry-run] [--json] | --self-test\n",
  );
}

function main(args = process.argv.slice(2)) {
  try {
    const options = parseFocusedAuditArgs(args);
    if (options.help) {
      printUsage();
      return 0;
    }
    return options.selfTest ? selfTest() : runGate(options);
  } catch (err) {
    // error-policy:J1 the executable boundary turns discovery/parser failure
    // into a non-zero audit result without fabricating a clean inventory.
    console.error(`[anti-larp] internal error: ${String(err)}`);
    return 2;
  }
}

if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
