#!/usr/bin/env node
/**
 * Non-blocking ratchet guarding against NEW fallback-slop error handling (#12263 / #12182).
 *
 * The repo carries thousands of pre-existing empty catches and server-side
 * `console.*` calls; a strict biome rule at error level would red `bun run
 * verify` for everyone. Instead this guard records the current baseline counts
 * and FAILS ONLY WHEN a count INCREASES — today's verify stays green, new slop
 * is blocked. Two kinds are tracked, classified via the TypeScript AST so tokens
 * inside strings/comments are never miscounted:
 *   - `emptyCatch`  — `catch { }` with an empty body (repo-wide production src).
 *   - `serverConsole` — `console.*` calls in server-side runtime packages
 *     (SERVER_CONSOLE_SCOPE); CLI stdout (packages/elizaos), scripts, and build
 *     files are intentionally out of scope.
 *
 * Batches under #12182 shrink the baseline as they delete slop; the ratchet
 * mechanically prevents backsliding. Modeled on type-safety-ratchet.mjs.
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
  "error-policy-ratchet-baseline.json",
);

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
const UPDATE_BASELINE = args.has("--update-baseline");

function usage() {
  console.log(`Usage: node packages/scripts/error-policy-ratchet.mjs [options]

Options:
  --json             Print machine-readable summary JSON.
  --self-test        Run the AST classifier + comparison self-test.
  --update-baseline  Rewrite the checked-in baseline to current counts.
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

function trackedSourceFiles() {
  const output = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\n").filter(Boolean))]
    .filter(isProductionSourceFile)
    .sort();
}

function summarize(findings) {
  const counts = Object.fromEntries(
    Object.keys(KIND_LABELS).map((kind) => [kind, 0]),
  );
  for (const finding of findings) counts[finding.kind] += 1;
  return counts;
}

function scanFiles(files) {
  const findings = [];
  for (const relPath of files) {
    const sourceText = readFileSync(path.join(ROOT, relPath), "utf8");
    findings.push(...collectFindings(sourceText, relPath));
  }
  return findings;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `Missing baseline ${path.relative(ROOT, BASELINE_PATH)}. Run with --update-baseline first.`,
    );
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function baselinePayload(files, counts) {
  return {
    schema: "eliza_error_policy_ratchet_v1",
    parent: "#12182",
    updatedAt: new Date().toISOString(),
    scope: {
      enumeration: "git ls-files",
      productionSourceOnly: true,
      serverConsoleScope: SERVER_CONSOLE_SCOPE,
    },
    limits: counts,
    filesScanned: files.length,
  };
}

/** Exported for the self-test. */
export function compareToBaseline(counts, baseline) {
  const limits = baseline.limits ?? {};
  const regressions = [];
  const improvements = [];
  for (const kind of Object.keys(KIND_LABELS)) {
    const current = counts[kind] ?? 0;
    const limit = limits[kind];
    if (!Number.isInteger(limit)) {
      regressions.push({
        kind,
        current,
        limit: null,
        message: `baseline is missing ${kind}`,
      });
      continue;
    }
    if (current > limit) regressions.push({ kind, current, limit });
    else if (current < limit) improvements.push({ kind, current, limit });
  }
  return { regressions, improvements };
}

function groupTopFiles(findings, kind, limit = 10) {
  const byFile = new Map();
  for (const finding of findings) {
    if (finding.kind !== kind) continue;
    byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
  }
  return [...byFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }));
}

function printHumanSummary({
  files,
  counts,
  baseline,
  findings,
  regressions,
  improvements,
}) {
  console.log(
    `[error-policy-ratchet] scanned ${files.length} tracked production source files`,
  );
  for (const kind of Object.keys(KIND_LABELS)) {
    const limit = baseline?.limits?.[kind];
    const limitText = Number.isInteger(limit) ? String(limit) : "missing";
    console.log(
      `[error-policy-ratchet] ${KIND_LABELS[kind]}: ${counts[kind]} / ${limitText}`,
    );
  }
  if (improvements.length > 0) {
    console.log(
      "[error-policy-ratchet] baseline can shrink:",
      improvements
        .map((i) => `${KIND_LABELS[i.kind]} ${i.limit} -> ${i.current}`)
        .join(", "),
    );
  }
  if (regressions.length === 0) return;
  console.error("[error-policy-ratchet] error-policy baseline exceeded");
  for (const regression of regressions) {
    const label = KIND_LABELS[regression.kind];
    if (regression.limit === null) {
      console.error(`  - ${label}: ${regression.message}`);
    } else {
      console.error(
        `  - ${label}: ${regression.current} current > ${regression.limit} baseline`,
      );
    }
    for (const row of groupTopFiles(findings, regression.kind)) {
      console.error(`      ${row.count} ${row.file}`);
    }
  }
  console.error(
    "\nNew fallback-slop error handling is blocked. Fix the failure (throw/typed error, logger over console) instead of adding it. See the Error-Handling Simplification policy in AGENTS.md.",
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
  const inScope = summarize(
    collectFindings(sample, "packages/core/src/sample.ts"),
  );
  if (inScope.emptyCatch !== 2 || inScope.serverConsole !== 2) {
    console.error(
      `[error-policy-ratchet] self-test failed (in-scope): ${JSON.stringify(inScope)}`,
    );
    process.exit(1);
  }

  // Out-of-scope file: empty catches still count, console does not.
  const outScope = summarize(
    collectFindings(sample, "packages/ui/src/sample.ts"),
  );
  if (outScope.emptyCatch !== 2 || outScope.serverConsole !== 0) {
    console.error(
      `[error-policy-ratchet] self-test failed (scope leak): ${JSON.stringify(outScope)}`,
    );
    process.exit(1);
  }

  // Comparison: an injected new violation over baseline must regress; equal or
  // fewer must not.
  const baseline = { limits: { emptyCatch: 2, serverConsole: 2 } };
  const clean = compareToBaseline(
    { emptyCatch: 2, serverConsole: 2 },
    baseline,
  );
  const regressed = compareToBaseline(
    { emptyCatch: 3, serverConsole: 2 },
    baseline,
  );
  const improved = compareToBaseline(
    { emptyCatch: 1, serverConsole: 2 },
    baseline,
  );
  if (clean.regressions.length !== 0) {
    console.error(
      "[error-policy-ratchet] self-test failed: clean counts regressed",
    );
    process.exit(1);
  }
  if (
    regressed.regressions.length !== 1 ||
    regressed.regressions[0].kind !== "emptyCatch"
  ) {
    console.error(
      "[error-policy-ratchet] self-test failed: injected violation not caught",
    );
    process.exit(1);
  }
  if (improved.improvements.length !== 1) {
    console.error(
      "[error-policy-ratchet] self-test failed: improvement not detected",
    );
    process.exit(1);
  }
  console.log("[error-policy-ratchet] self-test passed");
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

const files = trackedSourceFiles();
const findings = scanFiles(files);
const counts = summarize(findings);

let baseline;
if (UPDATE_BASELINE) {
  const next = baselinePayload(files, counts);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  baseline = next;
  if (!JSON_FLAG) {
    console.log(
      `[error-policy-ratchet] wrote ${path.relative(ROOT, BASELINE_PATH)}`,
    );
  }
} else {
  baseline = loadBaseline();
}

const { regressions, improvements } = compareToBaseline(counts, baseline);

if (JSON_FLAG) {
  console.log(
    JSON.stringify(
      {
        ok: regressions.length === 0,
        filesScanned: files.length,
        counts,
        limits: baseline.limits,
        regressions,
        improvements,
      },
      null,
      2,
    ),
  );
} else {
  printHumanSummary({
    files,
    counts,
    baseline,
    findings,
    regressions,
    improvements,
  });
}

if (regressions.length > 0) process.exit(1);
