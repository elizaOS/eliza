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
 *      skip `annotation` with a `description`. Runtime *conditional* skips whose
 *      first argument is not a string literal (`cond ? describe : describe.skip`,
 *      `test.skip(!process.env.X, "…")`) are always allowed. A bare
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
  /(?:^|[._-])(?:e2e[._-])?(?:test|spec)(?:[._-]|$)|(?:^|[._-])self-test(?:[._-]|$)/i;
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
export const TEST_SOURCE_EXCLUSIONS = new Map([
  [
    "packages/benchmarks/solana/solana-gym-env/voyager/skill_runner/_test_bad.ts",
    "deliberately invalid skill-runner input fixture; excluded by that runner's tsconfig and never executed by a JavaScript test framework",
  ],
]);

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

function normalizeRelativePath(value) {
  return value.split("\\").join("/").replace(/^\.\//, "");
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

function assertNoCaseCollisions(files) {
  const seen = new Map();
  for (const file of files) {
    const identity = normalizeRelativePath(file).toLocaleLowerCase("en-US");
    const previous = seen.get(identity);
    if (previous && previous !== file) {
      throw new Error(
        `case-colliding test source paths: ${previous} and ${file}`,
      );
    }
    seen.set(identity, file);
  }
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
  const eligible = files
    .map(normalizeRelativePath)
    .filter(isTestSourcePath)
    .sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  assertNoCaseCollisions(eligible);
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
  return files.map((rel) => ({
    rel,
    content: fs.readFileSync(path.join(root, rel), "utf8"),
  }));
}

function scriptKind(filePath) {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function callChain(expression) {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return callChain(expression.expression);
  }
  if (ts.isCallExpression(expression)) return callChain(expression.expression);
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const base = callChain(expression.expression);
    return base ? [...base, expression.name.text] : null;
  }
  if (ts.isElementAccessExpression(expression)) {
    const base = callChain(expression.expression);
    const key = expression.argumentExpression;
    if (!base || !key || !ts.isStringLiteralLike(key)) return null;
    return [...base, key.text];
  }
  return null;
}

function disabledModifier(chain) {
  if (!chain) return null;
  if (chain.length === 1 && DISABLED_ALIASES.has(chain[0])) return "alias";
  if (!RUNNER_ROOTS.has(chain[0])) return null;
  return chain.find((part) => DISABLED_MODIFIERS.has(part)) ?? null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isTrueLiteral(node) {
  return node && unwrapExpression(node).kind === ts.SyntaxKind.TrueKeyword;
}

function findModifierCall(node, modifier) {
  let current = node;
  while (current) {
    const unwrapped = unwrapExpression(current);
    if (!ts.isCallExpression(unwrapped)) return null;
    const chain = callChain(unwrapped.expression);
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

function hasOuterModifierCall(node, modifier, sourceFile) {
  const start = node.getStart(sourceFile);
  let parent = node.parent;
  while (parent && parent.getStart(sourceFile) === start) {
    if (
      ts.isCallExpression(parent) &&
      disabledModifier(callChain(parent.expression)) === modifier
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
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

  const violations = [];
  const recorded = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const chain = callChain(node.expression);
      const position = node.getStart(sourceFile);
      if (isFocusedChain(chain)) {
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
        const modifier = disabledModifier(chain);
        let documented = true;
        if (modifier && hasOuterModifierCall(node, modifier, sourceFile)) {
          documented = true;
        } else if (modifier === "skipIf" || modifier === "todoIf") {
          const modifierCall = findModifierCall(node, modifier);
          documented =
            !modifierCall ||
            !isTrueLiteral(modifierCall.arguments[0]) ||
            hasDocumentedDisable(sourceFile, node);
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

function writeInventoryReport(report) {
  const output = path.join(REPO_ROOT, "reports/test-source-inventory.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporary, output);
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
  if (failed > 0) {
    console.error(`\nself-test FAILED (${failed}/${cases.length})`);
    return 1;
  }
  console.log(`\nself-test PASSED (${cases.length}/${cases.length})`);
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
