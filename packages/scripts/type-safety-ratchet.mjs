#!/usr/bin/env node
/**
 * Fails when production source adds new unsafe TypeScript escape hatches.
 *
 * The gate is deliberately narrow: it tracks explicit cast escapes that are
 * easy to classify by AST and were called out in #9474. Broader strict-mode
 * migrations should tighten this baseline over time.
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
  "type-safety-ratchet-baseline.json",
);

const args = new Set(process.argv.slice(2));
const JSON_FLAG = args.has("--json");
const SELF_TEST = args.has("--self-test");
const UPDATE_BASELINE = args.has("--update-baseline");

const KIND_LABELS = {
  asUnknownAs: "as unknown as",
  asAny: "as any",
};

const EXCLUDED_SEGMENTS = new Set([
  "__fixtures__",
  "__mocks__",
  "__tests__",
  "fixtures",
  "mock",
  "mocks",
  "test",
  "tests",
]);

function usage() {
  console.log(`Usage: node packages/scripts/type-safety-ratchet.mjs [options]

Options:
  --json             Print machine-readable summary JSON.
  --self-test        Run the AST classifier self-test.
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

function trackedSourceFiles() {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      ":(glob)src/**/*.ts",
      ":(glob)src/**/*.tsx",
      ":(glob)**/src/**/*.ts",
      ":(glob)**/src/**/*.tsx",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );

  return [...new Set(output.split("\n").filter(Boolean))]
    .filter(isProductionSourceFile)
    .sort();
}

function sourceFileKind(relPath) {
  return relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function collectUnsafeCasts(sourceText, relPath) {
  const sourceFile = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceFileKind(relPath),
  );
  const findings = [];

  function record(kind, node) {
    const pos = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    findings.push({
      kind,
      file: relPath,
      line: pos.line + 1,
      snippet: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 160),
    });
  }

  function visit(node) {
    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        record("asAny", node);
      }
      if (
        ts.isAsExpression(node.expression) &&
        node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        record("asUnknownAs", node);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function summarize(findings) {
  const counts = { asUnknownAs: 0, asAny: 0 };
  for (const finding of findings) {
    counts[finding.kind] += 1;
  }
  return counts;
}

function scanFiles(files) {
  const findings = [];
  for (const relPath of files) {
    const fullPath = path.join(ROOT, relPath);
    const sourceText = readFileSync(fullPath, "utf8");
    findings.push(...collectUnsafeCasts(sourceText, relPath));
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
    schema: "eliza_type_safety_ratchet_v1",
    updatedAt: new Date().toISOString(),
    scope: {
      trackedOnly: true,
      globs: [
        "src/**/*.ts",
        "src/**/*.tsx",
        "**/src/**/*.ts",
        "**/src/**/*.tsx",
      ],
      excludes: [
        "*.d.ts",
        "*.test.ts",
        "*.test.tsx",
        "*.spec.ts",
        "*.spec.tsx",
        "*.e2e.ts",
        "*.e2e.tsx",
        "*.story.ts",
        "*.story.tsx",
        "*.stories.ts",
        "*.stories.tsx",
        "*.fixture.ts",
        "*.fixture.tsx",
        "*.mock.ts",
        "*.mock.tsx",
        "**/__fixtures__/**",
        "**/__mocks__/**",
        "**/__tests__/**",
        "**/fixtures/**",
        "**/mock/**",
        "**/mocks/**",
        "**/test/**",
        "**/tests/**",
      ],
    },
    limits: counts,
    filesScanned: files.length,
  };
}

function compareToBaseline(counts, baseline) {
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
    if (current > limit) {
      regressions.push({ kind, current, limit });
    } else if (current < limit) {
      improvements.push({ kind, current, limit });
    }
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
    `[type-safety-ratchet] scanned ${files.length} tracked production source files`,
  );

  for (const kind of Object.keys(KIND_LABELS)) {
    const limit = baseline?.limits?.[kind];
    const limitText = Number.isInteger(limit) ? String(limit) : "missing";
    console.log(
      `[type-safety-ratchet] ${KIND_LABELS[kind]}: ${counts[kind]} / ${limitText}`,
    );
  }

  if (improvements.length > 0) {
    console.log(
      "[type-safety-ratchet] baseline can shrink:",
      improvements
        .map(
          (item) =>
            `${KIND_LABELS[item.kind]} ${item.limit} -> ${item.current}`,
        )
        .join(", "),
    );
  }

  if (regressions.length === 0) return;

  console.error("[type-safety-ratchet] unsafe cast baseline exceeded");
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
}

function runSelfTest() {
  const sample = `
    declare const value: unknown;
    type Result = { ok: boolean };
    const one = value as unknown as Result;
    const two = value as any;
    const three = "value as any";
    // const four = value as unknown as Result;
    const five = value as unknown;
  `;
  const counts = summarize(collectUnsafeCasts(sample, "sample.ts"));
  if (counts.asUnknownAs !== 1 || counts.asAny !== 1) {
    console.error(
      `[type-safety-ratchet] self-test failed: ${JSON.stringify(counts)}`,
    );
    process.exit(1);
  }
  console.log("[type-safety-ratchet] self-test passed");
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
  const nextBaseline = baselinePayload(files, counts);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(nextBaseline, null, 2)}\n`);
  baseline = nextBaseline;
  if (!JSON_FLAG) {
    console.log(
      `[type-safety-ratchet] wrote ${path.relative(ROOT, BASELINE_PATH)}`,
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

if (regressions.length > 0) {
  process.exit(1);
}
