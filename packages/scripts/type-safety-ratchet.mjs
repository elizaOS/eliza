#!/usr/bin/env node
/**
 * Fails when production source adds new unsafe TypeScript escape hatches.
 *
 * The gate is deliberately narrow: it tracks explicit cast escapes
 * (`as any`, `as unknown as`) and the TypeScript error-suppression directives
 * (expect-error and its legacy ignore form) that are easy to classify by AST
 * and were called out in #9474. Suppressions are read from TypeScript's own
 * `sourceFile.commentDirectives`, so a directive token inside a string or a
 * comment about directives is not miscounted. Broader strict-mode migrations
 * should tighten this baseline over time.
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
  explicitAny: "explicit `: any` annotation",
  tsSuppress: "@ts-expect-error / @ts-ignore",
  nonNullAssertion: "non-null assertion (!)",
  // Empty-fallback sludge (#9940). A nullish-coalescing default that is an
  // empty string / array / object / 0 at a pipeline edge conflates "not loaded"
  // / "broken upstream" with "legitimately empty", so a broken pipeline renders
  // as a silent no-op instead of failing observably. Scoped to the runtime
  // packages (core/agent/app-core) via EMPTY_FALLBACK_SCOPE — those are the
  // measured hotspots and the layers architecture rule 8 governs.
  nullishEmptyString: '`?? ""` (core/agent/app-core)',
  nullishEmptyArray: "`?? []` (core/agent/app-core)",
  nullishEmptyObject: "`?? {}` (core/agent/app-core)",
  nullishZero: "`?? 0` (core/agent/app-core)",
};

// The empty-fallback budget only governs the runtime packages named in #9940;
// the cast/suppression kinds above stay repo-wide.
const EMPTY_FALLBACK_SCOPE = [
  "packages/core/src/",
  "packages/agent/src/",
  "packages/app-core/src/",
];

function inEmptyFallbackScope(relPath) {
  return EMPTY_FALLBACK_SCOPE.some((prefix) => relPath.startsWith(prefix));
}

// Classify the right operand of a `??` as an empty-fallback default, or return
// undefined. Parenthesized operands are unwrapped by the caller.
function emptyFallbackKind(node, ts) {
  if (ts.isStringLiteral(node) && node.text === "") {
    return "nullishEmptyString";
  }
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) {
    return "nullishEmptyArray";
  }
  if (ts.isObjectLiteralExpression(node) && node.properties.length === 0) {
    return "nullishEmptyObject";
  }
  if (ts.isNumericLiteral(node) && Number(node.text) === 0) {
    return "nullishZero";
  }
  return undefined;
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
  // Codegen output living outside a generated/ directory (e.g.
  // `*.generated.ts` next to its consumer). The gate polices hand-written
  // escape hatches; a generator that must emit a suppression documents the
  // constraint at its render site, and the `generated/` DIRECTORY exclusion
  // above already exempts the same category when it is folder-shaped.
  if (/\.generated\.(ts|tsx)$/.test(base)) return false;

  return true;
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

function sourceFileKind(relPath) {
  return relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

// Every package + plugin opts into full `strict` (#9474 Phase 2). This guard
// keeps it that way: any tracked tsconfig that re-introduces `"strict": false`
// fails the ratchet. `strictNullChecks`/`strictFunctionTypes`/etc. are distinct
// keys and are intentionally not matched.
// Configs allowed to keep `"strict": false`:
//  - emit-only build variants (they don't type-check; the strict CHECK lives in
//    the sibling type-checking tsconfig),
//  - a small set of example / sub-chain packages with open strict burndowns
//    tracked in #9474 Phase 2's tail.
// Anything else with `"strict": false` is a regression and fails the ratchet.
const STRICT_FALSE_ALLOWLIST = new Set([
  "packages/agent/tsconfig.bundle.json", // emit-only bundle config
  "plugins/tsconfig.build.shared.json", // emit-only (emitDeclarationOnly)
]);

function strictFalseTsconfigs() {
  const output = execFileSync(
    "git",
    ["ls-files", "--", ":(glob)**/tsconfig*.json"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const violations = [];
  for (const relPath of output.split("\n").filter(Boolean)) {
    if (STRICT_FALSE_ALLOWLIST.has(relPath)) {
      continue;
    }
    let text;
    try {
      text = readFileSync(path.join(ROOT, relPath), "utf8");
    } catch {
      continue;
    }
    if (/"strict"\s*:\s*false/.test(text)) {
      violations.push(relPath);
    }
  }
  return violations;
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

  function unwrapExpression(node) {
    let current = node;
    while (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    return current;
  }

  const trackEmptyFallbacks = inEmptyFallbackScope(relPath);

  function visit(node) {
    if (
      trackEmptyFallbacks &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const kind = emptyFallbackKind(unwrapExpression(node.right), ts);
      if (kind) {
        record(kind, node);
      }
    }

    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        record("asAny", node);
      }
      const expression = unwrapExpression(node.expression);
      if (
        ts.isAsExpression(expression) &&
        expression.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        record("asUnknownAs", node);
      }
    }

    // Non-null assertion operator (`expr!`). A postfix `!` that silently asserts
    // a value is not null/undefined — a runtime-unchecked escape in the same
    // family as the casts above. Definite-assignment assertions (`let x!: T`)
    // are a different node (PropertyDeclaration/VariableDeclaration exclamation
    // token), not a NonNullExpression, so they are correctly not counted.
    if (ts.isNonNullExpression(node)) {
      record("nonNullAssertion", node);
    }

    // Explicit `any` *type annotation* (a `: any` param/var/return type, a
    // generic argument like `Array<any>`, an `any[]` element type, etc.) — the
    // same surface biome's `noExplicitAny` flags. The `as any` *cast* form is a
    // separate AsExpression counted above; its AnyKeyword is the AsExpression's
    // `.type`, so we skip that case to avoid double-counting it as both.
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const parent = node.parent;
      const isAsAnyType =
        parent && ts.isAsExpression(parent) && parent.type === node;
      if (!isAsAnyType) {
        record("explicitAny", node);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Type-error suppression directives, read from TypeScript's own directive
  // table so we never miscount directive text that appears inside a string or
  // an unrelated comment. Covers expect-error and its compatibility ignore form.
  for (const directive of sourceFile.commentDirectives ?? []) {
    const pos = sourceFile.getLineAndCharacterOfPosition(directive.range.pos);
    findings.push({
      kind: "tsSuppress",
      file: relPath,
      line: pos.line + 1,
      snippet: sourceText
        .slice(directive.range.pos, directive.range.end)
        .replace(/\s+/g, " ")
        .slice(0, 160),
    });
  }

  return findings;
}

function summarize(findings) {
  const counts = Object.fromEntries(
    Object.keys(KIND_LABELS).map((kind) => [kind, 0]),
  );
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
      // Enumerate every tracked file via `git ls-files`, then keep production
      // source under a `src/` segment (see isProductionSourceFile). `globs`
      // documents the kept set; it is not the enumeration mechanism.
      enumeration: "git ls-files",
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
        "*.generated.ts",
        "*.generated.tsx",
        "**/__fixtures__/**",
        "**/__mocks__/**",
        "**/__tests__/**",
        "**/fixtures/**",
        "**/generated/**",
        "**/mock/**",
        "**/mocks/**",
        "**/test/**",
        "**/tests/**",
      ],
      // The nullish* empty-fallback kinds are additionally scoped to these
      // runtime packages (#9940); the cast/suppression kinds are repo-wide.
      emptyFallbackScope: EMPTY_FALLBACK_SCOPE,
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
    const six = (value as unknown) as Result;
    // @ts-expect-error self-test directive
    const seven: string = 1;
    // @ts-ignore self-test directive
    const eight: number = "x";
    const nine = "// @ts-ignore inside a string is not a directive";
    const ten = (value as Result)!;
    let eleven!: Result;
    const twelve: any = value;
    const emptyStr = (value as { s?: string }).s ?? "";
    const nonEmptyStr = (value as { s?: string }).s ?? "fallback";
    const emptyArr = (value as { a?: number[] }).a ?? [];
    const emptyObj = (value as { o?: object }).o ?? {};
    const zero = (value as { n?: number }).n ?? 0;
    const parenEmpty = (value as { s?: string }).s ?? ("");
  `;
  // Use an in-scope path so the empty-fallback budget (scoped to
  // core/agent/app-core) is exercised alongside the repo-wide cast kinds.
  const counts = summarize(
    collectUnsafeCasts(sample, "packages/core/src/sample.ts"),
  );
  if (
    counts.asUnknownAs !== 2 ||
    counts.asAny !== 1 ||
    // `twelve: any` is one explicit type-position any; the `value as any` above
    // is the cast form (asAny), not double-counted here.
    counts.explicitAny !== 1 ||
    counts.tsSuppress !== 2 ||
    // `ten` is a NonNullExpression; `eleven!` is a definite-assignment
    // assertion (not counted), so exactly one non-null assertion is expected.
    counts.nonNullAssertion !== 1 ||
    // `?? ""` appears twice (plain + parenthesized); `?? "fallback"` is not an
    // empty-string fallback and must not be counted.
    counts.nullishEmptyString !== 2 ||
    counts.nullishEmptyArray !== 1 ||
    counts.nullishEmptyObject !== 1 ||
    counts.nullishZero !== 1
  ) {
    console.error(
      `[type-safety-ratchet] self-test failed: ${JSON.stringify(counts)}`,
    );
    process.exit(1);
  }

  // Out-of-scope files must NOT contribute empty-fallback findings (the budget
  // is scoped; only the runtime packages are governed).
  const outOfScope = summarize(
    collectUnsafeCasts(sample, "packages/ui/src/sample.ts"),
  );
  if (
    outOfScope.nullishEmptyString !== 0 ||
    outOfScope.nullishEmptyArray !== 0 ||
    outOfScope.nullishEmptyObject !== 0 ||
    outOfScope.nullishZero !== 0
  ) {
    console.error(
      `[type-safety-ratchet] self-test failed (scope leak): ${JSON.stringify(outOfScope)}`,
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

const strictFalse = strictFalseTsconfigs();
if (strictFalse.length > 0 && !JSON_FLAG) {
  console.error(
    `[type-safety-ratchet] ${strictFalse.length} tsconfig(s) set "strict": false (must be true — #9474 Phase 2):`,
  );
  for (const relPath of strictFalse) {
    console.error(`  - ${relPath}`);
  }
}

if (regressions.length > 0 || strictFalse.length > 0) {
  process.exit(1);
}
