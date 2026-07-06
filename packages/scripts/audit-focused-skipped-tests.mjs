#!/usr/bin/env node
/**
 * audit-focused-skipped-tests.mjs — anti-larp CI gate (#10718).
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
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const TEST_FILE_PATHSPECS = [
  "*.test.ts",
  "*.test.tsx",
  "*.test.mts",
  "*.test.cts",
  "*.test.mjs",
  "*.test.js",
  "*.test.jsx",
  "*.spec.ts",
  "*.spec.tsx",
  "*.spec.mjs",
  "*.spec.js",
  "*.spec.jsx",
];

// Focused-test forms. `it/describe/test/suite/bench/context` are unambiguously
// test-runner globals inside a test file, so `<runner>.only` is always a focused
// test. `fdescribe`/`fit` are the jasmine-style focus aliases (require a call).
const FOCUSED_PATTERNS = [
  /\b(?:describe|it|test|suite|bench|context)\.only\b/,
  /\bf(?:describe|it)\s*\(/,
];

// Skip/pending/exclude forms — DIRECT CALLS only. Requiring the `(` after
// skip and pending-call forms deliberately exclude the sanctioned conditional-runner
// pattern `cond ? describe : describe.skip` (and `const runner = ok ? it : it.skip`),
// which is how real/live suites skip CLEANLY when a dependency (postgres, pty,
// codex, ffmpeg, live keys) is absent — that is not larp. Only a literal
// `it.skip("name", fn)` — a hardcoded, unconditionally-disabled test — is flagged.
const SKIP_PATTERNS = [
  /\b(?:describe|it|test|suite|bench|context)\.(?:skip|todo)\s*\(/,
  /\bx(?:it|describe)\s*\(/,
];

// A skip is compliant — traceable, not silently dropped (#10718) — when the
// nearby window either LINKS a tracking issue OR explains itself with a reason.
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
  /\b(?:requires?|missing|unavailable|disabled|not\s+(?:run|on|available|installed|supported|enabled|configured)|set\b[^\n]*\benabl|skipped|enable\b|only\s+(?:on|runs?)|stub\b|not on PATH|platform|no\s+\w+\s+(?:available|installed|found|backend|store)|process\.(?:platform|env)|os\.platform|isCI|when\b|un-?skip|not yet|pending|once\b[^\n]*\blands?\b|backend|no shared)\b|—|"[^"]*\$\{|`[^`]*\$\{/i;
// Playwright's structured skip annotation is first-class documentation.
const PW_ANNOTATION = /annotation\b[\s\S]{0,240}?\bdescription\s*:/i;

// Look a few lines up (comment/condition) and further down (multi-line call +
// Playwright annotation object) for the reason/ref.
const SKIP_WINDOW_UP = 4;
const SKIP_WINDOW_DOWN = 10;

/** Comment-only lines can't run a test — skip them so prose/docstrings that
 * mention `it.only` (like this file) never trip the gate. */
function isCommentOnlyLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Does the skip CALL starting at `lineIdx` pass a string literal as its FIRST
 * argument? A string first arg (`it.skip("test name", fn)`) is a hardcoded,
 * unconditionally-disabled named test — the case the gate scrutinizes. A
 * non-string first arg (`test.skip(!process.env.X, "reason")`,
 * `describe.skip(shouldRun)`) is a RUNTIME CONDITIONAL skip — Playwright/vitest's
 * supported "skip when this condition holds" API — which is legitimate, so those
 * are always compliant. Scans forward across up to a few lines to the first
 * non-whitespace char after the opening `(`.
 */
function skipFirstArgIsStringLiteral(lines, lineIdx) {
  const joined = lines.slice(lineIdx, lineIdx + 4).join("\n");
  const call = joined.match(
    /\b(?:describe|it|test|suite|bench|context)\.(?:skip|todo)\s*\(|\bx(?:it|describe)\s*\(/,
  );
  if (!call) return true; // be conservative: treat as hardcoded if unsure
  const afterParen = joined.slice(call.index + call[0].length);
  const firstChar = afterParen.replace(/^\s+/, "")[0];
  return firstChar === '"' || firstChar === "'" || firstChar === "`";
}

function listTrackedTestFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--", ...TEST_FILE_PATHSPECS],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return (
    out
      .split("\0")
      .filter(Boolean)
      // The gate never scans itself or its self-test fixtures.
      .filter((f) => !f.endsWith("audit-focused-skipped-tests.mjs"))
  );
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {{file:string,line:number,kind:'focused'|'orphaned-skip',text:string}[]}
 */
export function findViolations(filePath, content) {
  const violations = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnlyLine(line)) continue;

    if (FOCUSED_PATTERNS.some((re) => re.test(line))) {
      violations.push({
        file: filePath,
        line: i + 1,
        kind: "focused",
        text: line.trim().slice(0, 120),
      });
      continue;
    }

    if (SKIP_PATTERNS.some((re) => re.test(line))) {
      // Runtime conditional skips (non-string first arg) are always legitimate.
      if (!skipFirstArgIsStringLiteral(lines, i)) continue;
      const start = Math.max(0, i - SKIP_WINDOW_UP);
      const end = Math.min(lines.length, i + 1 + SKIP_WINDOW_DOWN);
      const window = lines.slice(start, end).join("\n");
      if (
        !TRACKING_REF.test(window) &&
        !REASON_MARKER.test(window) &&
        !PW_ANNOTATION.test(window)
      ) {
        violations.push({
          file: filePath,
          line: i + 1,
          kind: "orphaned-skip",
          text: line.trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

function runGate({ dryRun }) {
  const files = listTrackedTestFiles();
  /** @type {ReturnType<typeof findViolations>} */
  const all = [];
  for (const rel of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      continue;
    }
    all.push(...findViolations(rel, content));
  }

  const focused = all.filter((v) => v.kind === "focused");
  const orphaned = all.filter((v) => v.kind === "orphaned-skip");

  console.log(
    `[anti-larp] scanned ${files.length} test files — ${focused.length} focused, ${orphaned.length} orphaned skip(s)`,
  );

  if (all.length === 0) {
    console.log("[anti-larp] clean — no focused tests, no untracked skips.");
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

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--self-test")) {
    process.exit(selfTest());
  }
  try {
    process.exit(runGate({ dryRun: args.has("--dry-run") }));
  } catch (err) {
    console.error(`[anti-larp] internal error: ${String(err)}`);
    process.exit(2);
  }
}

main();
