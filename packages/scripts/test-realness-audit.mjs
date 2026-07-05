#!/usr/bin/env node

/**
 * test-realness-audit.mjs
 *
 * Repo-wide static audit for non-running and weak test coverage signals
 * (#10718). Two tiers:
 *
 * ENFORCED (hard failure, zero tolerance, cannot be baselined away):
 *   - focusedOnly    `.only` focus — including chained-modifier forms like
 *                    `describe.sequential.only(` and `.scenario.*` files that
 *                    audit-focused-skipped-tests.mjs (#10829) does not scan.
 *   - todoTest       `it.todo(` — a named test with no body. #10829 exempts
 *                    todos that carry a tracking ref; this gate holds the tree
 *                    at unconditional zero: write the test or file the issue
 *                    without a phantom test entry.
 *   - xSkippedTest   `xit(` / `xdescribe(` jasmine-style disabled suites,
 *                    likewise held at unconditional zero.
 *
 * REPORT-ONLY (counted, printed, written to --report/--json, never exit 1):
 *   - skippedTest / conditionalSkip / envEarlyReturn / envConditionalSuite:
 *     conditional and env-gated skips are explicitly sanctioned by the merged
 *     #10829 gate (packages/scripts/audit-focused-skipped-tests.mjs) for
 *     platform / live-API lanes, and literal `.skip(` debt is already enforced
 *     with the right nuance by #10829 (tracking-ref/reason window) and by
 *     packages/scripts/lint-test-integrity.mjs (ratchet allowlist). Hard-gating
 *     raw counts here would double-gate the same lines and red every PR that
 *     adds a sanctioned platform gate.
 *   - mockCallOnlyAssertion: the line-level heuristic flags
 *     `expect(mock).toHaveBeenCalled*` in tests that ALSO assert real outcomes
 *     on neighboring lines (~57% of the inventory), so it is a review signal,
 *     not a mergeable-quality boundary.
 *   - tautologicalAssertion: same heuristic caveat — most hits are
 *     scaffolding inside otherwise-real tests.
 *
 * The baseline file (test-realness-baseline.json) is a reference snapshot used
 * for delta reporting on the report-only categories; it does not gate. Use
 * `--report` / `--json` to produce issue-evidence artifacts for #10718.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(here, "..", "..");
const DEFAULT_BASELINE_PATH = path.join(here, "test-realness-baseline.json");

const SKIP_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "tsbuild",
]);

const SCAN_ROOTS = ["packages", "plugins"];
const TEST_FILE_PATTERN =
  /(?:\.scenario\.[cm]?[jt]s|(?:\.|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?)$/;
const TEST_CALL_ROOTS = new Set(["context", "describe", "it", "suite", "test"]);
const FOCUSED_METHODS = new Set(["only"]);
const NON_RUNNING_METHODS = new Set(["skip", "skipIf", "todo"]);
const ISSUE_REF_PATTERN =
  /(?:https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+|#\d+|TODO\(#\d+\))/u;

export const CATEGORY_LABELS = Object.freeze({
  focusedOnly: "Focused .only test",
  skippedTest: "Skipped test or suite",
  todoTest: "Todo test",
  conditionalSkip: "Conditional skip",
  xSkippedTest: "xdescribe/xit disabled suite",
  envEarlyReturn: "Env-gated early return",
  envConditionalSuite: "Env-gated conditional suite",
  tautologicalAssertion: "Tautological assertion",
  mockCallOnlyAssertion: "Mock-call-only assertion",
});

const CHECKED_CATEGORIES = Object.keys(CATEGORY_LABELS);

// Hard-failure set. Deliberate-larp categories that are zero-stable on the
// tree and must stay zero. Everything else is report-only — see the header
// comment for the per-category rationale (overlap with the #10829 gate and
// lint-test-integrity.mjs, and the mock-call heuristic's false-positive rate).
export const ENFORCED_CATEGORIES = Object.freeze([
  "focusedOnly",
  "todoTest",
  "xSkippedTest",
]);

export const DIFF_SCOPED_CATEGORIES = Object.freeze([
  "mockCallOnlyAssertion",
  "tautologicalAssertion",
]);

export const REPORT_ONLY_CATEGORIES = Object.freeze(
  CHECKED_CATEGORIES.filter(
    (category) =>
      !ENFORCED_CATEGORIES.includes(category) &&
      !DIFF_SCOPED_CATEGORIES.includes(category),
  ),
);

function normalizeRepoPath(value) {
  return value.split(path.sep).join("/");
}

function repoRelative(repoRoot, filePath) {
  return normalizeRepoPath(path.relative(repoRoot, filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isTestFile(filePath) {
  return TEST_FILE_PATTERN.test(normalizeRepoPath(filePath));
}

function* walkFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(path.join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && isTestFile(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

function collectTestFiles(repoRoot) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const absRoot = path.join(repoRoot, scanRoot);
    if (!fs.existsSync(absRoot)) continue;
    files.push(...walkFiles(absRoot));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function stripCommentsAndStrings(sourceText) {
  let out = "";
  let state = "code";
  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];

    if (state === "line-comment") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      } else {
        out += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        out += "  ";
        i++;
        state = "code";
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\\") {
        if (i + 1 < sourceText.length) {
          out += sourceText[i + 1] === "\n" ? "\n" : " ";
          i++;
        }
        continue;
      }
      if (
        (state === "single" && ch === "'") ||
        (state === "double" && ch === '"') ||
        (state === "template" && ch === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      out += "  ";
      i++;
      state = "line-comment";
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i++;
      state = "block-comment";
      continue;
    }
    if (ch === "'") state = "single";
    else if (ch === '"') state = "double";
    else if (ch === "`") state = "template";
    out += ch;
  }
  return out;
}

function lineAndText(sourceText, lineNumber) {
  const text = sourceText.split(/\r?\n/u)[lineNumber - 1] ?? "";
  return { line: lineNumber, text: text.trim() };
}

function hasIssueReference(sourceText, lineIndex) {
  const lines = sourceText.split(/\r?\n/u);
  const start = Math.max(0, lineIndex - 3);
  const end = Math.min(lines.length - 1, lineIndex + 1);
  for (let i = start; i <= end; i++) {
    if (ISSUE_REF_PATTERN.test(lines[i] ?? "")) return true;
  }
  return false;
}

function makeFinding({
  category,
  repoRoot,
  filePath,
  sourceText,
  lineNumber,
  detail,
}) {
  const { line, text } = lineAndText(sourceText, lineNumber);
  return {
    category,
    label: CATEGORY_LABELS[category],
    path: repoRelative(repoRoot, filePath),
    line,
    detail,
    tracked: hasIssueReference(sourceText, line - 1),
    snippet: text,
  };
}

function addRegexFinding({
  findings,
  category,
  repoRoot,
  filePath,
  sourceText,
  lineNumber,
  detail,
}) {
  findings.push(
    makeFinding({
      category,
      repoRoot,
      filePath,
      sourceText,
      lineNumber,
      detail,
    }),
  );
}

export function analyzeTestSource(repoRoot, relativePath, sourceText) {
  const filePath = path.join(repoRoot, relativePath);
  const codeText = stripCommentsAndStrings(sourceText);
  const codeLines = codeText.split(/\r?\n/u);
  const findings = [];

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i] ?? "";
    const lineNumber = i + 1;
    const focusedPattern = new RegExp(
      `\\b(?:${[...TEST_CALL_ROOTS].join("|")})(?:\\.[A-Za-z_$][\\w$]*)*\\.(${[...FOCUSED_METHODS].join("|")})\\s*\\(`,
      "u",
    );
    const nonRunningPattern = new RegExp(
      `\\b(?:${[...TEST_CALL_ROOTS].join("|")})(?:\\.[A-Za-z_$][\\w$]*)*\\.(${[...NON_RUNNING_METHODS].join("|")})\\s*\\(`,
      "u",
    );
    const focusedMatch = line.match(focusedPattern);
    if (focusedMatch) {
      addRegexFinding({
        findings,
        category: "focusedOnly",
        repoRoot,
        filePath,
        sourceText,
        lineNumber,
        detail: `${focusedMatch[0].replace(/\s*\($/u, "")}() focuses the suite and drops sibling tests.`,
      });
    }

    const nonRunningMatch = line.match(nonRunningPattern);
    if (nonRunningMatch) {
      const method = nonRunningMatch[1];
      const category =
        method === "todo"
          ? "todoTest"
          : method === "skipIf"
            ? "conditionalSkip"
            : "skippedTest";
      addRegexFinding({
        findings,
        category,
        repoRoot,
        filePath,
        sourceText,
        lineNumber,
        detail: `${nonRunningMatch[0].replace(/\s*\($/u, "")}() registers a non-running or conditionally-running test.`,
      });
    }

    const xMatch = line.match(/\b(xdescribe|xit)\s*\(/u);
    if (xMatch) {
      addRegexFinding({
        findings,
        category: "xSkippedTest",
        repoRoot,
        filePath,
        sourceText,
        lineNumber,
        detail: `${xMatch[1]}() disables this test path.`,
      });
    }

    if (/\bif\s*\([^)]*\bprocess\.env\b[^)]*\)/u.test(line)) {
      const window = codeLines.slice(i, i + 8).join("\n");
      if (/\breturn\s*;/u.test(window) && !/\bthrow\b/u.test(window)) {
        addRegexFinding({
          findings,
          category: "envEarlyReturn",
          repoRoot,
          filePath,
          sourceText,
          lineNumber,
          detail:
            "process.env guard returns from the test instead of failing or visibly skipping.",
        });
      }
      if (
        /\b(?:describe|it|test|suite|context)(?:\.[A-Za-z_$][\w$]*)*\s*\(/u.test(
          window,
        ) &&
        !/\belse\b/u.test(window)
      ) {
        addRegexFinding({
          findings,
          category: "envConditionalSuite",
          repoRoot,
          filePath,
          sourceText,
          lineNumber,
          detail:
            "process.env guard conditionally registers tests, so absent env can erase coverage.",
        });
      }
    }

    if (
      /\bexpect\s*\(\s*(true|false|0|1|""|''|``)\s*\)\s*\.\s*to(?:Be|Equal|StrictEqual)\s*\(\s*\1\s*\)/u.test(
        line,
      )
    ) {
      addRegexFinding({
        findings,
        category: "tautologicalAssertion",
        repoRoot,
        filePath,
        sourceText,
        lineNumber,
        detail: "Assertion compares a literal to itself.",
      });
    }

    if (
      /\bexpect\s*\(\s*(?:[^)\n]*mock[^)\n]*|(?:vi|jest)\.[a-zA-Z]+[^)\n]*)\s*\)\s*\.\s*toHaveBeenCalled(?:Times|With)?\s*\(/iu.test(
        line,
      )
    ) {
      addRegexFinding({
        findings,
        category: "mockCallOnlyAssertion",
        repoRoot,
        filePath,
        sourceText,
        lineNumber,
        detail:
          "Assertion proves a mock was invoked; pair it with the real outcome or artifact.",
      });
    }
  }

  return findings;
}

function analyzeFile(repoRoot, filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  return analyzeTestSource(
    repoRoot,
    repoRelative(repoRoot, filePath),
    sourceText,
  );
}

function summarize(findings, filesScanned) {
  const byCategory = Object.fromEntries(
    CHECKED_CATEGORIES.map((category) => [category, 0]),
  );
  let untrackedSkips = 0;
  for (const finding of findings) {
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    if (
      [
        "skippedTest",
        "todoTest",
        "conditionalSkip",
        "xSkippedTest",
        "envEarlyReturn",
        "envConditionalSuite",
      ].includes(finding.category) &&
      !finding.tracked
    ) {
      untrackedSkips += 1;
    }
  }
  return {
    filesScanned,
    findings: findings.length,
    byCategory,
    untrackedSkips,
  };
}

export function scanTestRealness({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const files = collectTestFiles(repoRoot);
  const findings = files.flatMap((filePath) => analyzeFile(repoRoot, filePath));
  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.category.localeCompare(right.category),
  );
  return {
    repoRoot,
    files,
    findings,
    summary: summarize(findings, files.length),
  };
}

/**
 * Only the ENFORCED_CATEGORIES can fail the gate, and they are held at zero
 * regardless of what the baseline file says — a baseline edit cannot smuggle a
 * focused/todo/x-disabled test past CI. Report-only categories never fail.
 */
export function collectFailures(result) {
  const failures = [];
  const byCategory = result.summary.byCategory;
  for (const category of ENFORCED_CATEGORIES) {
    const actual = Number(byCategory[category] ?? 0);
    if (actual > 0) {
      failures.push(`${category} must stay at 0, found ${actual}`);
    }
  }
  return failures;
}

function countByFileAndCategory(findings, categories) {
  const counts = new Map();
  for (const finding of findings) {
    if (!categories.includes(finding.category)) continue;
    const key = `${finding.path}\0${finding.category}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function collectDiffScopedRegressions({
  currentFindings,
  baseFindings,
  changedFiles,
  categories = DIFF_SCOPED_CATEGORIES,
}) {
  const current = countByFileAndCategory(currentFindings, categories);
  const base = countByFileAndCategory(baseFindings, categories);
  const changed = new Set(changedFiles);
  const regressions = [];

  for (const file of changed) {
    for (const category of categories) {
      const key = `${file}\0${category}`;
      const currentCount = current.get(key) ?? 0;
      const baseCount = base.get(key) ?? 0;
      if (currentCount > baseCount) {
        regressions.push({
          file,
          category,
          current: currentCount,
          base: baseCount,
        });
      }
    }
  }

  return regressions.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.category.localeCompare(right.category),
  );
}

export function collectDiffScopedFailures(regressions) {
  return regressions.map(
    (r) =>
      `${r.category} increased in touched test file ${r.file}: ${r.current} current > ${r.base} base`,
  );
}

export function collectDiffScopedGateFailures(diffScoped) {
  if (diffScoped.skipped) {
    return [
      `diff-scoped ratchet could not run: ${diffScoped.reason}. Ensure CI fetches origin/develop before running --check.`,
    ];
  }
  return diffScoped.failures;
}

export function buildBaseline(result) {
  return {
    version: 2,
    description:
      "Reference snapshot for packages/scripts/test-realness-audit.mjs. Only the enforced categories (focusedOnly, todoTest, xSkippedTest) gate CI, and they are held at zero regardless of this file; the remaining counts are report-only deltas. Regenerate with --print-baseline.",
    thresholds: {
      ...result.summary.byCategory,
      untrackedSkips: result.summary.untrackedSkips,
    },
  };
}

function markdownEscape(value) {
  return String(value).replace(/\|/gu, "\\|");
}

export function buildMarkdownReport(
  result,
  baseline,
  failures = [],
  diffScoped = null,
) {
  const lines = [];
  lines.push("# #10718 Test Realness Inventory");
  lines.push("");
  lines.push(
    "Generated by `node packages/scripts/test-realness-audit.mjs --check`.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `- Test/scenario files scanned: **${result.summary.filesScanned}**`,
  );
  lines.push(`- Findings inventoried: **${result.summary.findings}**`);
  lines.push(
    `- Untracked skip/todo/env-gated findings: **${result.summary.untrackedSkips}**`,
  );
  lines.push(`- Gate status: **${failures.length === 0 ? "pass" : "fail"}**`);
  lines.push("");
  lines.push(
    "Enforced categories fail CI when above zero; report-only categories are inventoried for #10718 remediation and never fail the gate (they are enforced with nuance by audit-focused-skipped-tests.mjs and lint-test-integrity.mjs).",
  );
  lines.push("");
  lines.push("| Category | Mode | Current | Reference | Delta |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const category of CHECKED_CATEGORIES) {
    const current = result.summary.byCategory[category] ?? 0;
    const allowed = baseline?.thresholds?.[category] ?? 0;
    const mode = ENFORCED_CATEGORIES.includes(category)
      ? "enforced"
      : DIFF_SCOPED_CATEGORIES.includes(category)
        ? "diff-scoped"
        : "report-only";
    lines.push(
      `| ${markdownEscape(CATEGORY_LABELS[category])} | ${mode} | ${current} | ${allowed} | ${current - allowed} |`,
    );
  }
  lines.push(
    `| Untracked skip/todo/env-gated findings | report-only | ${result.summary.untrackedSkips} | ${baseline?.thresholds?.untrackedSkips ?? 0} | ${result.summary.untrackedSkips - (baseline?.thresholds?.untrackedSkips ?? 0)} |`,
  );
  lines.push("");

  if (failures.length > 0) {
    lines.push("## Gate Failures");
    lines.push("");
    for (const failure of failures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
  }

  if (diffScoped && !diffScoped.skipped) {
    lines.push("## Diff-Scoped Ratchet");
    lines.push("");
    lines.push(
      `- Base: \`${diffScoped.baseRef}\` (${diffScoped.base.slice(0, 10)})`,
    );
    lines.push(`- Changed test files: **${diffScoped.changedFiles.length}**`);
    lines.push(`- Regressions: **${diffScoped.regressions.length}**`);
    if (diffScoped.regressions.length > 0) {
      lines.push("");
      lines.push("| File | Category | Base | Current |");
      lines.push("| --- | --- | ---: | ---: |");
      for (const regression of diffScoped.regressions) {
        lines.push(
          `| \`${regression.file}\` | ${markdownEscape(CATEGORY_LABELS[regression.category])} | ${regression.base} | ${regression.current} |`,
        );
      }
    }
    lines.push("");
  } else if (diffScoped?.skipped) {
    lines.push("## Diff-Scoped Ratchet");
    lines.push("");
    lines.push(`- Skipped: ${diffScoped.reason}`);
    lines.push("");
  }

  lines.push("## Inventory");
  lines.push("");
  lines.push(
    "The JSON companion file contains the complete machine-readable inventory. The table below lists the first 400 findings for human review.",
  );
  lines.push("");
  lines.push("| Category | Tracked | Location | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const finding of result.findings.slice(0, 400)) {
    lines.push(
      `| ${markdownEscape(finding.label)} | ${finding.tracked ? "yes" : "no"} | \`${finding.path}:${finding.line}\` | ${markdownEscape(finding.detail)} |`,
    );
  }
  if (result.findings.length > 400) {
    lines.push(
      `| ... | ... | ... | ${result.findings.length - 400} additional findings in JSON inventory |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {
    check: false,
    printBaseline: false,
    repoRoot: DEFAULT_REPO_ROOT,
    baselinePath: DEFAULT_BASELINE_PATH,
    reportPath: null,
    jsonPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--print-baseline") {
      args.printBaseline = true;
    } else if (arg === "--repo-root") {
      args.repoRoot = path.resolve(argv[++i]);
    } else if (arg === "--baseline") {
      args.baselinePath = path.resolve(argv[++i]);
    } else if (arg === "--report") {
      args.reportPath = path.resolve(argv[++i]);
    } else if (arg === "--json") {
      args.jsonPath = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node packages/scripts/test-realness-audit.mjs [options]",
          "",
          "Options:",
          "  --check             Fail if enforced categories (focusedOnly, todoTest, xSkippedTest) are above zero.",
          "  --print-baseline    Print the current reference-snapshot JSON to stdout.",
          "  --repo-root <dir>   Repo root override for self-tests.",
          "  --baseline <file>   Baseline JSON path.",
          "  --report <file>     Write a Markdown report.",
          "  --json <file>       Write a JSON inventory.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function git(repoRoot, argv, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", argv, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function resolveBaseRef(repoRoot) {
  const candidates = ["origin/develop", "develop"];
  for (const ref of candidates) {
    if (
      git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        allowFailure: true,
      })
    ) {
      return ref;
    }
  }
  return null;
}

function mergeBaseWith(repoRoot, ref) {
  const out = git(repoRoot, ["merge-base", ref, "HEAD"], {
    allowFailure: true,
  });
  return out ? out.trim() : null;
}

function changedTestFiles(repoRoot, base) {
  const out = git(repoRoot, ["diff", "--name-only", "-z", base, "HEAD"], {
    allowFailure: true,
  });
  if (!out) return [];
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter(isTestFile)
    .sort();
}

function baseContent(repoRoot, base, relPath) {
  return git(repoRoot, ["show", `${base}:${relPath}`], {
    allowFailure: true,
  });
}

function collectBaseFindingsForChangedFiles(repoRoot, base, files) {
  return files.flatMap((relPath) => {
    const sourceText = baseContent(repoRoot, base, relPath);
    if (sourceText === null) return [];
    return analyzeTestSource(repoRoot, relPath, sourceText);
  });
}

function diffScopedCheck(result, repoRoot) {
  const baseRef = resolveBaseRef(repoRoot);
  if (!baseRef) {
    return {
      skipped: true,
      reason: "no base ref found",
      baseRef: null,
      base: null,
      changedFiles: [],
      regressions: [],
      failures: [],
    };
  }

  const base = mergeBaseWith(repoRoot, baseRef);
  if (!base) {
    return {
      skipped: true,
      reason: `could not compute merge-base with ${baseRef}`,
      baseRef,
      base: null,
      changedFiles: [],
      regressions: [],
      failures: [],
    };
  }

  const changedFiles = changedTestFiles(repoRoot, base);
  const baseFindings = collectBaseFindingsForChangedFiles(
    repoRoot,
    base,
    changedFiles,
  );
  const regressions = collectDiffScopedRegressions({
    currentFindings: result.findings,
    baseFindings,
    changedFiles,
  });

  return {
    skipped: false,
    reason: null,
    baseRef,
    base,
    changedFiles,
    regressions,
    failures: collectDiffScopedFailures(regressions),
  };
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = scanTestRealness({ repoRoot: args.repoRoot });

  if (args.printBaseline) {
    process.stdout.write(`${JSON.stringify(buildBaseline(result), null, 2)}\n`);
    return;
  }

  const baseline = fs.existsSync(args.baselinePath)
    ? readJson(args.baselinePath)
    : buildBaseline(result);
  const diffScoped = diffScopedCheck(result, args.repoRoot);
  const failures = [
    ...collectFailures(result),
    ...(args.check
      ? collectDiffScopedGateFailures(diffScoped)
      : diffScoped.failures),
  ];

  if (args.jsonPath) {
    writeFileEnsuringDir(
      args.jsonPath,
      `${JSON.stringify(
        {
          summary: result.summary,
          diffScoped,
          findings: result.findings,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (args.reportPath) {
    writeFileEnsuringDir(
      args.reportPath,
      buildMarkdownReport(result, baseline, failures, diffScoped),
    );
  }

  process.stdout.write(
    `[test-realness-audit] files=${result.summary.filesScanned} findings=${result.summary.findings} untracked=${result.summary.untrackedSkips}\n`,
  );
  for (const category of CHECKED_CATEGORIES) {
    const mode = ENFORCED_CATEGORIES.includes(category)
      ? "enforced"
      : DIFF_SCOPED_CATEGORIES.includes(category)
        ? "diff-scoped"
        : "report-only";
    process.stdout.write(
      `[test-realness-audit] ${category}=${result.summary.byCategory[category] ?? 0} reference=${baseline?.thresholds?.[category] ?? 0} mode=${mode}\n`,
    );
  }
  process.stdout.write(
    `[test-realness-audit] untrackedSkips=${result.summary.untrackedSkips} reference=${baseline?.thresholds?.untrackedSkips ?? 0} mode=report-only\n`,
  );
  if (diffScoped.skipped) {
    process.stdout.write(
      `[test-realness-audit] diffScoped=skipped reason=${diffScoped.reason}\n`,
    );
  } else {
    process.stdout.write(
      `[test-realness-audit] diffScoped=checked base=${diffScoped.baseRef} changedTestFiles=${diffScoped.changedFiles.length} regressions=${diffScoped.regressions.length}\n`,
    );
  }

  if (args.check && failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`[test-realness-audit] FAIL ${failure}\n`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
