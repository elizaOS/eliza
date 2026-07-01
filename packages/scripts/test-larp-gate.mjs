#!/usr/bin/env node
/**
 * test-larp-gate.mjs — CI gate that prevents test-larp regressions (#10718).
 *
 * Three checks, run over every first-party test file
 * (`*.test.ts(x)` / `*.spec.ts(x)`), excluding vendored / built / cached trees
 * (node_modules, dist, .turbo, coverage, `scripts/bun-riscv64`, `src-cache`):
 *
 *   1. NO `.only` — `it.only` / `describe.only` / `test.only` / `bench.only`
 *      silently drop every sibling test, so a single stray `.only` turns a whole
 *      file green while running one case. Hard fail, no baseline: the tree is at
 *      zero and must stay there.
 *
 *   2. NO UNTRACKED SKIP — every `it.skip` / `describe.skip` / `.todo` /
 *      `xit` / `xdescribe` / `xtest` must carry a tracking reference on the
 *      skip line or the line above it: a `#<issue>` GitHub ref or an explicit
 *      `larp-gate-allow: <reason>` tag. Existing skips are grandfathered by the
 *      baseline; NEW untracked skips fail. Ratchets down only (removing a skip
 *      shrinks the baseline via --update-baseline; it can never grow silently).
 *
 *   3. Detection is AST-based (TypeScript scanner over the real call graph), so
 *      a `.only` inside a string, a comment, or a docstring is never miscounted.
 *
 * Flags: --json (machine report), --update-baseline (rewrite the baseline to the
 * current tracked+untracked set — run intentionally when you legitimately add or
 * remove a skip), --self-test (unit-check the classifier on synthetic inputs).
 *
 * NOT covered here (documented residual, tracked in the #10718 report): "every
 * test file is claimed by exactly one CI lane". That needs per-package vitest
 * include-glob resolution and is enforced separately; see AUDIT-REPORT.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASELINE_PATH = path.join(
  ROOT,
  "packages",
  "scripts",
  "test-larp-gate-baseline.json",
);

const args = new Set(process.argv.slice(2));
const JSON_FLAG = args.has("--json");
const UPDATE_BASELINE = args.has("--update-baseline");
const SELF_TEST = args.has("--self-test");

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;
const EXCLUDE_DIR_RE =
  /(^|\/)(node_modules|dist|\.turbo|coverage|\.cache|storybook-static|src-cache|bun-riscv64|build|out|\.next)(\/|$)/;

// Runner identifiers whose `.only` / `.skip` / `.todo` we police.
const RUNNERS = new Set(["it", "test", "describe", "bench", "suite"]);
const X_PREFIXED = new Set(["xit", "xtest", "xdescribe"]);
const SKIP_MEMBERS = new Set(["skip", "todo", "skipIf", "runIf", "failing"]);
// `.only` is always fatal; these members are skips subject to the tracking rule.
// `skipIf`/`runIf`/`failing` still register a suite but conditionally suppress
// it, so we hold them to the same "must be tracked" bar as a hard skip.

/**
 * Walk a source file's AST and collect every policed marker:
 *   { kind: 'only' | 'skip', member, runner, line (1-based) }
 * Catches both call forms (`it.skip(...)`) and bare property access in a
 * ternary (`shouldSkip ? describe.skip : describe`), plus the `xit`/`xdescribe`
 * identifier form.
 */
function collectMarkers(sourceText, fileName) {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const markers = [];
  const lineOf = (node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node) => {
    // Property access: <runner>.<member> — e.g. it.only, describe.skip, test.todo
    if (ts.isPropertyAccessExpression(node)) {
      const obj = node.expression;
      const member = node.name.text;
      // Resolve the root runner identifier, allowing one chain hop
      // (it.skip, test.concurrent.only, describe.skip.each are all rooted here).
      let rootName = null;
      if (ts.isIdentifier(obj)) rootName = obj.text;
      else if (
        ts.isPropertyAccessExpression(obj) &&
        ts.isIdentifier(obj.expression)
      )
        rootName = obj.expression.text;
      if (rootName && RUNNERS.has(rootName)) {
        if (member === "only") {
          markers.push({ kind: "only", member, runner: rootName, line: lineOf(node) });
        } else if (SKIP_MEMBERS.has(member)) {
          markers.push({ kind: "skip", member, runner: rootName, line: lineOf(node) });
        }
      }
    }
    // Identifier call form: xit(...), xdescribe(...), xtest(...)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (X_PREFIXED.has(name)) {
        markers.push({
          kind: "skip",
          member: name,
          runner: name.slice(1),
          line: lineOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return markers;
}

const ISSUE_REF_RE = /#\d{2,}\b|https?:\/\/\S*\/(issues|pull)\/\d+/i;
const ALLOW_TAG_RE = /larp-gate-allow:\s*\S+/i;

/** A skip is "tracked" if its line or the line above carries an issue ref or allow tag. */
function isTracked(lines, lineIdx1) {
  const here = lines[lineIdx1 - 1] ?? "";
  const above = lines[lineIdx1 - 2] ?? "";
  const hay = `${above}\n${here}`;
  return ISSUE_REF_RE.test(hay) || ALLOW_TAG_RE.test(hay);
}

function listTestFiles() {
  // git ls-files keeps us to tracked, first-party sources; fall back to a walk
  // if we are somehow outside a git tree.
  let files;
  try {
    files = execFileSync(
      "git",
      ["ls-files", "packages", "plugins", "*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    files = [];
  }
  return files.filter(
    (f) => TEST_FILE_RE.test(f) && !EXCLUDE_DIR_RE.test(f),
  );
}

function keyFor(file, marker) {
  // Stable-ish key independent of line drift: file + runner.member.
  // Multiple untracked skips of the same shape in one file collapse to a count.
  return `${file}::${marker.runner}.${marker.member}`;
}

function scan() {
  const files = listTestFiles();
  const onlyViolations = [];
  const untrackedSkips = new Map(); // key -> { file, member, runner, count, lines }
  for (const file of files) {
    const abs = path.join(ROOT, file);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!/\.(only|skip|todo|skipIf|runIf|failing)\b|\bx(it|test|describe)\b/.test(text)) {
      continue; // fast reject: no marker tokens at all
    }
    const lines = text.split("\n");
    const markers = collectMarkers(text, abs);
    for (const m of markers) {
      if (m.kind === "only") {
        onlyViolations.push({ file, line: m.line, marker: `${m.runner}.only` });
      } else if (!isTracked(lines, m.line)) {
        const key = keyFor(file, m);
        const rec =
          untrackedSkips.get(key) ??
          { file, member: m.member, runner: m.runner, count: 0, lines: [] };
        rec.count += 1;
        rec.lines.push(m.line);
        untrackedSkips.set(key, rec);
      }
    }
  }
  return { files: files.length, onlyViolations, untrackedSkips };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { untrackedSkips: {} };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return { untrackedSkips: {} };
  }
}

function selfTest() {
  const cases = [
    { src: `it.only('x', () => {})`, expect: { only: 1, skip: 0 } },
    { src: `describe.only('x', () => {})`, expect: { only: 1, skip: 0 } },
    { src: `it.skip('x', () => {})`, expect: { only: 0, skip: 1 } },
    { src: `test.todo('later')`, expect: { only: 0, skip: 1 } },
    { src: `const d = cond ? describe.skip : describe`, expect: { only: 0, skip: 1 } },
    { src: `xit('x', () => {})`, expect: { only: 0, skip: 1 } },
    { src: `xdescribe('x', () => {})`, expect: { only: 0, skip: 1 } },
    { src: `// it.only is banned`, expect: { only: 0, skip: 0 } },
    { src: `const s = "describe.only"`, expect: { only: 0, skip: 0 } },
    { src: `it('real', () => { expect(1).toBe(1) })`, expect: { only: 0, skip: 0 } },
    { src: `test.skip(!server, 'no server')`, expect: { only: 0, skip: 1 } },
  ];
  let failed = 0;
  for (const [i, c] of cases.entries()) {
    const markers = collectMarkers(c.src, `case-${i}.test.ts`);
    const only = markers.filter((m) => m.kind === "only").length;
    const skip = markers.filter((m) => m.kind === "skip").length;
    if (only !== c.expect.only || skip !== c.expect.skip) {
      failed += 1;
      console.error(
        `  self-test #${i} FAIL: ${JSON.stringify(c.src)} → only=${only} skip=${skip}, expected ${JSON.stringify(c.expect)}`,
      );
    }
  }
  if (failed) {
    console.error(`[test-larp-gate] self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(`[test-larp-gate] self-test: all ${cases.length} cases passed`);
  process.exit(0);
}

function main() {
  if (SELF_TEST) return selfTest();

  const { files, onlyViolations, untrackedSkips } = scan();
  const baseline = loadBaseline();
  const baselineKeys = new Set(Object.keys(baseline.untrackedSkips ?? {}));

  // New untracked skips = present now, absent from baseline.
  const newUntracked = [];
  for (const [key, rec] of untrackedSkips) {
    if (!baselineKeys.has(key)) newUntracked.push({ key, ...rec });
  }

  if (UPDATE_BASELINE) {
    const next = { generatedAt: new Date().toISOString().slice(0, 10), untrackedSkips: {} };
    for (const [key, rec] of untrackedSkips) {
      next.untrackedSkips[key] = { count: rec.count };
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `[test-larp-gate] baseline updated: ${Object.keys(next.untrackedSkips).length} grandfathered untracked-skip sites across ${files} files`,
    );
    return;
  }

  const report = {
    files,
    onlyViolations,
    untrackedSkipSites: untrackedSkips.size,
    grandfathered: baselineKeys.size,
    newUntracked,
  };

  if (JSON_FLAG) {
    console.log(JSON.stringify(report, null, 2));
  }

  let failed = false;
  if (onlyViolations.length > 0) {
    failed = true;
    console.error(
      `\n[test-larp-gate] ✗ ${onlyViolations.length} \`.only\` marker(s) — these drop sibling tests and must be removed:`,
    );
    for (const v of onlyViolations) console.error(`    ${v.file}:${v.line}  (${v.marker})`);
  }
  if (newUntracked.length > 0) {
    failed = true;
    console.error(
      `\n[test-larp-gate] ✗ ${newUntracked.length} NEW untracked skip site(s) — add a \`#<issue>\` ref or \`larp-gate-allow: <reason>\` on the skip line (or line above):`,
    );
    for (const v of newUntracked) {
      console.error(`    ${v.file}  ${v.runner}.${v.member}  (line${v.lines.length > 1 ? "s" : ""} ${v.lines.join(", ")})`);
    }
  }

  if (failed) {
    console.error(
      `\n[test-larp-gate] FAILED. Scanned ${files} first-party test files.`,
    );
    process.exit(1);
  }
  console.log(
    `[test-larp-gate] ✓ ${files} test files: 0 \`.only\`, no new untracked skips (${baselineKeys.size} grandfathered).`,
  );
}

main();
