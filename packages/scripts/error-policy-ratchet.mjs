#!/usr/bin/env node
/**
 * Diff-scoped guard against NEW fallback-slop error handling (#12263 / #12182).
 *
 * The repo carries thousands of pre-existing empty catches and server-side
 * `console.*` calls; a repo-wide count-vs-baseline gate cannot work here: any
 * static baseline goes stale the moment `develop` merges an unrelated PR that
 * adds one more empty catch, which then reds `bun run verify` for everyone who
 * rebases. So enforcement is scoped to the diff, not the repo:
 *
 *   base = git merge-base <base-ref> HEAD        (default base-ref origin/develop)
 *   for each production source file the branch touches (base..HEAD):
 *     fail iff its CURRENT (working-tree) empty-catch / server-console count is
 *     GREATER than the same file's count at `base`.
 *
 * This enforces exactly "a PR may not ADD slop in the files it touches" while
 * being completely immune to drift in files the PR does not touch. On `develop`
 * itself (nothing differs from origin/develop) the diff is empty and the guard
 * is a no-op that passes. When no base ref is resolvable (e.g. a shallow clone
 * without origin/develop) the guard cannot scope a diff and passes rather than
 * block on an unknowable baseline.
 *
 * Two kinds are tracked, classified via the TypeScript AST so tokens inside
 * strings/comments are never miscounted:
 *   - `emptyCatch`  — `catch { }` with an empty body (production src, repo-wide).
 *   - `serverConsole` — `console.*` calls in server-side runtime packages
 *     (SERVER_CONSOLE_SCOPE); CLI stdout (packages/elizaos), scripts, and build
 *     files are intentionally out of scope.
 *
 * The repo-wide totals remain available for #12182 sweep tracking via `--report`
 * (informational only — never affects the exit code).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "../..");

const KIND_LABELS = {
  emptyCatch: "empty catch block (`catch {}`)",
  serverConsole: "server-side `console.*` call",
};

// Server-side runtime packages where the logger-only rule applies. The
// console kind is scoped to these; the empty-catch kind is repo-wide.
const SERVER_CONSOLE_SCOPE = [
  "packages/core/src/",
  "packages/agent/src/",
  "packages/app-core/src/",
  "packages/shared/src/",
  "packages/prompts/src/",
];

function inServerConsoleScope(relPath) {
  return SERVER_CONSOLE_SCOPE.some((prefix) => relPath.startsWith(prefix));
}

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

const args = new Set(process.argv.slice(2));
const JSON_FLAG = args.has("--json");
const SELF_TEST = args.has("--self-test");
const REPORT = args.has("--report");

function usage() {
  console.log(`Usage: node packages/scripts/error-policy-ratchet.mjs [options]

Diff-scoped: fails only when a production source file the branch touches
increases its own empty-catch / server-console count vs the merge-base with
origin/develop. Immune to unrelated develop drift.

Options:
  --json        Print machine-readable diff-scoped result JSON.
  --report      Also compute + print the repo-wide totals (informational only).
  --self-test   Run the AST classifier + comparison self-test.

Env:
  ERROR_POLICY_BASE_REF  Override the base ref (default: origin/develop, then develop).
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

function sourceFileKind(relPath) {
  return relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Classify one source file's text. Empty catch blocks are counted everywhere;
 * console.* calls only when the file is in SERVER_CONSOLE_SCOPE. Exported for
 * the self-test.
 */
export function collectFindings(sourceText, relPath) {
  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceFileKind(relPath),
  );
  const findings = [];
  const trackConsole = inServerConsoleScope(relPath);

  function record(kind, node) {
    const pos = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    findings.push({ kind, file: relPath, line: pos.line + 1 });
  }

  function visit(node) {
    if (
      ts.isCatchClause(node) &&
      node.block &&
      node.block.statements.length === 0
    ) {
      record("emptyCatch", node);
    }

    if (
      trackConsole &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      record("serverConsole", node);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function summarize(findings) {
  const counts = Object.fromEntries(
    Object.keys(KIND_LABELS).map((kind) => [kind, 0]),
  );
  for (const finding of findings) counts[finding.kind] += 1;
  return counts;
}

function countText(sourceText, relPath) {
  return summarize(collectFindings(sourceText, relPath));
}

function git(argv, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", argv, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
    });
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

/** First resolvable ref among the env override, origin/develop, develop. */
function resolveBaseRef() {
  const candidates = [
    process.env.ERROR_POLICY_BASE_REF,
    "origin/develop",
    "develop",
  ].filter(Boolean);
  for (const ref of candidates) {
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowFailure: true,
    })) {
      return ref;
    }
  }
  return null;
}

/** Merge-base of the base ref and HEAD; null if it cannot be computed. */
function mergeBaseWith(ref) {
  const out = git(["merge-base", ref, "HEAD"], { allowFailure: true });
  return out ? out.trim() : null;
}

/** Production source files the branch touches relative to the merge-base. */
function changedProductionFiles(base) {
  const out = git(["diff", "--name-only", "-z", `${base}`, "HEAD"], {
    allowFailure: true,
  });
  if (!out) return [];
  return [...new Set(out.split("\0").filter(Boolean))]
    .filter(isProductionSourceFile)
    .sort();
}

/** File content at `base`, or null if the file did not exist there. */
function baseContent(base, relPath) {
  return git(["show", `${base}:${relPath}`], { allowFailure: true });
}

/** Working-tree content, or null if the file was deleted on the branch. */
function workingTreeContent(relPath) {
  try {
    return readFileSync(path.join(ROOT, relPath), "utf8");
  } catch {
    return null;
  }
}

const ZERO_COUNTS = Object.fromEntries(
  Object.keys(KIND_LABELS).map((kind) => [kind, 0]),
);

/**
 * Pure per-file comparison: which kinds increased vs the base counts.
 * Exported for the self-test.
 */
export function compareFileCounts(current, baseCounts) {
  const regressions = [];
  for (const kind of Object.keys(KIND_LABELS)) {
    const cur = current[kind] ?? 0;
    const prev = baseCounts[kind] ?? 0;
    if (cur > prev) regressions.push({ kind, current: cur, base: prev });
  }
  return regressions;
}

/**
 * For each changed production file, compare its working-tree count to its
 * count at the merge-base. New files compare against zero.
 */
function diffScopedRegressions(base, files) {
  const perFile = [];
  const regressions = [];
  for (const relPath of files) {
    const currentText = workingTreeContent(relPath);
    if (currentText === null) continue; // deleted on the branch — nothing added.
    const current = countText(currentText, relPath);

    const baseText = baseContent(base, relPath);
    const baseCounts =
      baseText === null ? { ...ZERO_COUNTS } : countText(baseText, relPath);

    perFile.push({ file: relPath, current, base: baseCounts });
    for (const r of compareFileCounts(current, baseCounts)) {
      regressions.push({ file: relPath, ...r });
    }
  }
  return { perFile, regressions };
}

/** Repo-wide informational totals (never gates). */
function repoWideTotals() {
  const output = git(["ls-files"]);
  const files = [...new Set(output.split("\n").filter(Boolean))].filter(
    isProductionSourceFile,
  );
  const findings = [];
  for (const relPath of files) {
    findings.push(...collectFindings(readFileSync(path.join(ROOT, relPath), "utf8"), relPath));
  }
  return { filesScanned: files.length, counts: summarize(findings) };
}

function printHumanSummary({ baseRef, base, files, perFile, regressions }) {
  console.log(
    `[error-policy-ratchet] base ${baseRef} (${base.slice(0, 10)}); ${files.length} changed production source file(s)`,
  );
  for (const row of perFile) {
    const deltas = Object.keys(KIND_LABELS)
      .map((kind) => `${kind} ${row.base[kind] ?? 0}->${row.current[kind] ?? 0}`)
      .join(", ");
    console.log(`[error-policy-ratchet]   ${row.file}: ${deltas}`);
  }
  if (regressions.length === 0) {
    console.log("[error-policy-ratchet] no new fallback-slop in touched files");
    return;
  }
  console.error("[error-policy-ratchet] new fallback-slop added in touched files:");
  for (const r of regressions) {
    console.error(
      `  - ${r.file}: ${KIND_LABELS[r.kind]} ${r.base} -> ${r.current}`,
    );
  }
  console.error(
    "\nA PR may not ADD empty catches or server-side console calls to the files it touches. Fix the failure (throw/typed error, logger over console) instead of adding it. See the Error-Handling Simplification policy in AGENTS.md.",
  );
}

function runSelfTest() {
  const sample = `
    function a() {
      try { risky(); } catch {}
      try { risky(); } catch (e) {}
      try { risky(); } catch (e) { logger.error(e); }
      console.log("in scope");
      console.error("in scope");
      const s = "console.log not a call";
      // console.warn commented out
      obj.console.log("not global console");
    }
  `;
  const inScope = countText(sample, "packages/core/src/sample.ts");
  if (inScope.emptyCatch !== 2 || inScope.serverConsole !== 2) {
    console.error(
      `[error-policy-ratchet] self-test failed (in-scope): ${JSON.stringify(inScope)}`,
    );
    process.exit(1);
  }

  // Out-of-scope file: empty catches still count, console does not.
  const outScope = countText(sample, "packages/ui/src/sample.ts");
  if (outScope.emptyCatch !== 2 || outScope.serverConsole !== 0) {
    console.error(
      `[error-policy-ratchet] self-test failed (scope leak): ${JSON.stringify(outScope)}`,
    );
    process.exit(1);
  }

  // Diff-scoped comparison: only an INCREASE over the same file's base regresses.
  const unchanged = compareFileCounts(
    { emptyCatch: 2, serverConsole: 2 },
    { emptyCatch: 2, serverConsole: 2 },
  );
  const added = compareFileCounts(
    { emptyCatch: 3, serverConsole: 2 },
    { emptyCatch: 2, serverConsole: 2 },
  );
  const removed = compareFileCounts(
    { emptyCatch: 1, serverConsole: 2 },
    { emptyCatch: 2, serverConsole: 2 },
  );
  const newFileClean = compareFileCounts(
    { emptyCatch: 0, serverConsole: 0 },
    { ...ZERO_COUNTS },
  );
  const newFileSlop = compareFileCounts(
    { emptyCatch: 1, serverConsole: 0 },
    { ...ZERO_COUNTS },
  );
  if (unchanged.length !== 0) {
    console.error("[error-policy-ratchet] self-test failed: unchanged file regressed");
    process.exit(1);
  }
  if (added.length !== 1 || added[0].kind !== "emptyCatch") {
    console.error("[error-policy-ratchet] self-test failed: added slop not caught");
    process.exit(1);
  }
  if (removed.length !== 0) {
    console.error("[error-policy-ratchet] self-test failed: removal counted as regression");
    process.exit(1);
  }
  if (newFileClean.length !== 0) {
    console.error("[error-policy-ratchet] self-test failed: clean new file regressed");
    process.exit(1);
  }
  if (newFileSlop.length !== 1 || newFileSlop[0].kind !== "emptyCatch") {
    console.error("[error-policy-ratchet] self-test failed: new-file slop not caught");
    process.exit(1);
  }
  console.log("[error-policy-ratchet] self-test passed");
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

const baseRef = resolveBaseRef();
const base = baseRef ? mergeBaseWith(baseRef) : null;

if (!base) {
  const reason = baseRef
    ? `no merge-base with ${baseRef}`
    : "no base ref (origin/develop) resolvable";
  const repoWide = REPORT ? repoWideTotals() : null;
  if (JSON_FLAG) {
    console.log(
      JSON.stringify(
        { ok: true, skipped: reason, baseRef, mergeBase: null, repoWide },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[error-policy-ratchet] ${reason}; diff-scoped check skipped (pass)`,
    );
    if (repoWide) {
      console.log(
        `[error-policy-ratchet] repo-wide (informational): emptyCatch ${repoWide.counts.emptyCatch}, serverConsole ${repoWide.counts.serverConsole} across ${repoWide.filesScanned} files`,
      );
    }
  }
  process.exit(0);
}

const files = changedProductionFiles(base);
const { perFile, regressions } = diffScopedRegressions(base, files);
const repoWide = REPORT ? repoWideTotals() : null;

if (JSON_FLAG) {
  console.log(
    JSON.stringify(
      {
        ok: regressions.length === 0,
        baseRef,
        mergeBase: base,
        changedFiles: files,
        perFile,
        regressions,
        repoWide,
      },
      null,
      2,
    ),
  );
} else {
  printHumanSummary({ baseRef, base, files, perFile, regressions });
  if (repoWide) {
    console.log(
      `[error-policy-ratchet] repo-wide (informational): emptyCatch ${repoWide.counts.emptyCatch}, serverConsole ${repoWide.counts.serverConsole} across ${repoWide.filesScanned} files`,
    );
  }
}

if (regressions.length > 0) process.exit(1);
