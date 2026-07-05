#!/usr/bin/env node

/**
 * audit-ui-determinism - fail CI on render-time nondeterminism in the UI.
 *
 * Render-time `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`,
 * `performance.now()`, and locale-defaulted `toLocale*` calls make a component
 * render differently every run - which makes screenshots flaky and snapshots
 * meaningless. This audit parses each component with the TypeScript AST and
 * classifies every such call by execution context:
 *
 *   render-time  -> runs while React renders the component/hook (or in useMemo).
 *                  GATED. These break visual determinism.
 *   deferred     -> runs in useEffect / an event handler / a timer / a promise
 *                  callback. ALLOWED (it does not run during render).
 *   module/util  -> a module-level helper we cannot prove is render-eager.
 *                  Reported, not gated.
 *
 * A committed baseline (eslint-style) records the existing render-time backlog
 * so the gate fails on NEW occurrences while the backlog is burned down.
 * Regenerate with `--update-baseline`.
 *
 *   node packages/scripts/audit-ui-determinism.mjs            # gate
 *   node packages/scripts/audit-ui-determinism.mjs --json     # machine output
 *   node packages/scripts/audit-ui-determinism.mjs --update-baseline
 *   node packages/scripts/audit-ui-determinism.mjs --self-test
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const updateBaseline = args.has("--update-baseline");
const selfTest = args.has("--self-test");

const SCAN_ROOT = path.join("packages", "ui", "src");
const BASELINE_PATH = path.join(
  "packages",
  "scripts",
  "ui-determinism-baseline.json",
);

const SKIP = [
  /\.test\.tsx?$/,
  /\.stories\.tsx?$/,
  /\.d\.ts$/,
  /[\\/]__e2e__[\\/]/,
  /[\\/]__tests__[\\/]/,
  /[\\/]test[\\/]/,
  /\.fuzz\./,
];

// Functions whose callback bodies do NOT run during render.
const DEFERRED_CALLERS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useCallback",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
  "addEventListener",
  "then",
  "catch",
  "finally",
]);

// ---------------------------------------------------------------------------
// file discovery
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      const rel = path.relative(repoRoot, full);
      if (!SKIP.some((re) => re.test(rel))) out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// AST classification
// ---------------------------------------------------------------------------
function isComponentOrHookName(name) {
  return !!name && (/^[A-Z]/.test(name) || /^use[A-Z0-9]/.test(name));
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  // const Foo = (..) => .. / const useX = function(){}
  const parent = node.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (
    parent &&
    ts.isPropertyAssignment(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return null;
}

function containsJsx(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (
      ts.isJsxElement(n) ||
      ts.isJsxSelfClosingElement(n) ||
      ts.isJsxFragment(n)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Is `fn` an argument to a deferred caller, a JSX on* handler, or async? */
function isDeferredCallback(fn) {
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return true;
  }
  const parent = fn.parent;
  if (!parent) return false;
  // arg to a deferred caller: useEffect(() => {...})
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    let name = null;
    if (ts.isIdentifier(callee)) name = callee.text;
    else if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
    if (name && DEFERRED_CALLERS.has(name)) return true;
  }
  // JSX handler: onClick={() => ...} / onChange={...}
  if (ts.isJsxAttribute(parent) && parent.name) {
    const attr = parent.name.getText?.() ?? "";
    if (/^on[A-Z]/.test(attr)) return true;
  }
  if (
    ts.isJsxExpression(parent) &&
    parent.parent &&
    ts.isJsxAttribute(parent.parent)
  ) {
    const attr = parent.parent.name?.getText?.() ?? "";
    if (/^on[A-Z]/.test(attr)) return true;
  }
  return false;
}

/**
 * Classify a forbidden call node by execution context.
 * @returns {"render-time"|"deferred"|"module"}
 */
function classify(node) {
  let cur = node.parent;
  let outerComponentOrHook = null;
  while (cur) {
    if (isFunctionLike(cur)) {
      if (isDeferredCallback(cur)) return "deferred";
      const name = functionName(cur);
      if (isComponentOrHookName(name) || (containsJsx(cur) && !name)) {
        outerComponentOrHook = cur;
      }
    }
    // a `render:` property holding an arrow (story / table cell renderer)
    cur = cur.parent;
  }
  if (outerComponentOrHook) return "render-time";
  return "module";
}

// ---------------------------------------------------------------------------
// forbidden-call detection
// ---------------------------------------------------------------------------
function detectKind(node) {
  // Date.now()
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "now"
  ) {
    const obj = node.expression.expression;
    if (ts.isIdentifier(obj) && obj.text === "Date") return "Date.now()";
    if (ts.isIdentifier(obj) && obj.text === "performance") {
      return "performance.now()";
    }
  }
  // new Date() with zero args
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    (!node.arguments || node.arguments.length === 0)
  ) {
    return "new Date()";
  }
  // Math.random()
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "random" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Math"
  ) {
    return "Math.random()";
  }
  // *.randomUUID()
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "randomUUID"
  ) {
    return "crypto.randomUUID()";
  }
  // *.toLocale{String,DateString,TimeString}() with no explicit locale arg
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    /^toLocale(String|DateString|TimeString)$/.test(node.expression.name.text)
  ) {
    const first = node.arguments[0];
    const hasLocale =
      first &&
      (ts.isStringLiteral(first) ||
        ts.isArrayLiteralExpression(first) ||
        ts.isIdentifier(first) ||
        ts.isPropertyAccessExpression(first));
    if (!hasLocale) return `${node.expression.name.text}() [no locale]`;
  }
  return null;
}

function scanFile(file, sourceText) {
  const src = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const visit = (node) => {
    const kind = detectKind(node);
    if (kind) {
      const ctx = classify(node);
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
      findings.push({ kind, context: ctx, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return findings;
}

function occurrenceKind(occurrence) {
  const match = /^L\d+\s+(.+)$/.exec(occurrence);
  return match?.[1] ?? occurrence;
}

function countByKind(occurrences) {
  const counts = new Map();
  for (const occurrence of occurrences) {
    const kind = occurrenceKind(occurrence);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

function regressionsForFile(currentOccurrences, baselineOccurrences) {
  const allowedCounts = countByKind(baselineOccurrences);
  const seenCounts = new Map();
  const fresh = [];

  for (const occurrence of currentOccurrences) {
    const kind = occurrenceKind(occurrence);
    const seen = (seenCounts.get(kind) ?? 0) + 1;
    seenCounts.set(kind, seen);
    if (seen > (allowedCounts.get(kind) ?? 0)) {
      fresh.push(occurrence);
    }
  }

  return fresh;
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
function runSelfTest() {
  const cases = [
    [
      "render Date.now",
      "function Foo(){ const t = Date.now(); return <div>{t}</div>; }",
      "render-time",
      "Date.now()",
    ],
    [
      "effect Date.now",
      "function Foo(){ useEffect(()=>{ const t=Date.now(); },[]); return <div/>; }",
      "deferred",
      "Date.now()",
    ],
    [
      "handler random",
      "function Foo(){ return <button onClick={()=>{ Math.random(); }}/>; }",
      "deferred",
      "Math.random()",
    ],
    [
      "hook render uuid",
      "function useX(){ const id = crypto.randomUUID(); return id; }",
      "render-time",
      "crypto.randomUUID()",
    ],
    [
      "useMemo is render",
      "function Foo(){ const v = useMemo(()=> Date.now(), []); return <div>{v}</div>; }",
      "render-time",
      "Date.now()",
    ],
    [
      "module util",
      "function fmt(){ return new Date().toLocaleString(); }",
      "module",
      "new Date()",
    ],
    [
      "explicit locale ok",
      "function Foo(){ const d = new Date(1); return <div>{d.toLocaleString('en-US')}</div>; }",
      null,
      null,
    ],
    [
      "new Date(arg) ok",
      "function Foo(){ const d = new Date(123); return <div>{+d}</div>; }",
      null,
      null,
    ],
    [
      "timeout deferred",
      "function Foo(){ setTimeout(()=>{ Math.random(); }, 10); return <div/>; }",
      "deferred",
      "Math.random()",
    ],
  ];
  let failed = 0;
  for (const [label, code, expectedCtx, expectedKind] of cases) {
    const findings = scanFile("case.tsx", code);
    if (expectedCtx === null) {
      const renderFindings = findings.filter(
        (f) => f.context === "render-time",
      );
      if (renderFindings.length) {
        failed++;
        console.error(
          `FAIL ${label}: expected no render-time finding, got ${JSON.stringify(renderFindings)}`,
        );
      } else {
        console.log(`OK ${label}`);
      }
      continue;
    }
    const match = findings.find((f) => f.kind === expectedKind);
    if (!match) {
      failed++;
      console.error(
        `FAIL ${label}: expected a ${expectedKind} finding, got ${JSON.stringify(findings)}`,
      );
    } else if (match.context !== expectedCtx) {
      failed++;
      console.error(
        `FAIL ${label}: expected context ${expectedCtx}, got ${match.context}`,
      );
    } else {
      console.log(`OK ${label}`);
    }
  }
  const driftOnly = regressionsForFile(
    ["L42 Date.now()", "L99 toLocaleString() [no locale]"],
    ["L12 Date.now()", "L16 toLocaleString() [no locale]"],
  );
  if (driftOnly.length) {
    failed++;
    console.error(
      `FAIL baseline line drift: expected no regression, got ${JSON.stringify(driftOnly)}`,
    );
  } else {
    console.log("OK baseline line drift");
  }

  const extraOccurrence = regressionsForFile(
    ["L42 Date.now()", "L99 Date.now()"],
    ["L12 Date.now()"],
  );
  if (JSON.stringify(extraOccurrence) !== JSON.stringify(["L99 Date.now()"])) {
    failed++;
    console.error(
      `FAIL baseline extra occurrence: expected one new occurrence, got ${JSON.stringify(extraOccurrence)}`,
    );
  } else {
    console.log("OK baseline extra occurrence");
  }

  if (failed) {
    console.error(`\nself-test FAILED (${failed})`);
    process.exit(1);
  }
  console.log("\nself-test PASSED");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  if (selfTest) return runSelfTest();

  const scanDir = path.join(repoRoot, SCAN_ROOT);
  if (!fs.existsSync(scanDir)) {
    console.error(
      `audit-ui-determinism: ${SCAN_ROOT} not found (run from repo root, local mode).`,
    );
    process.exit(2);
  }
  const files = walk(scanDir);
  /** @type {Record<string, string[]>} key = "relpath", value = ["L<line> <kind>"] */
  const renderTime = {};
  let totalRender = 0;
  let totalDeferred = 0;
  let totalModule = 0;

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const findings = scanFile(file, fs.readFileSync(file, "utf8"));
    for (const f of findings) {
      if (f.context === "render-time") {
        if (!renderTime[rel]) renderTime[rel] = [];
        renderTime[rel].push(`L${f.line} ${f.kind}`);
        totalRender++;
      } else if (f.context === "deferred") totalDeferred++;
      else totalModule++;
    }
  }
  for (const k of Object.keys(renderTime)) renderTime[k].sort();

  if (updateBaseline) {
    fs.writeFileSync(
      path.join(repoRoot, BASELINE_PATH),
      `${JSON.stringify(sortKeys(renderTime), null, 2)}\n`,
    );
    console.log(
      `audit-ui-determinism: baseline written - ${totalRender} render-time occurrences across ${Object.keys(renderTime).length} files.`,
    );
    return;
  }

  let baseline = {};
  try {
    baseline = JSON.parse(
      fs.readFileSync(path.join(repoRoot, BASELINE_PATH), "utf8"),
    );
  } catch {
    baseline = {};
  }

  // A regression = a render-time occurrence present now but not in baseline.
  const regressions = {};
  let regressionCount = 0;
  for (const [file, occ] of Object.entries(renderTime)) {
    const fresh = regressionsForFile(occ, baseline[file] || []);
    if (fresh.length) {
      regressions[file] = fresh;
      regressionCount += fresh.length;
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          totals: {
            renderTime: totalRender,
            deferred: totalDeferred,
            module: totalModule,
          },
          regressions,
          regressionCount,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `audit-ui-determinism: render-time=${totalRender} deferred=${totalDeferred} module=${totalModule} (baseline ${Object.keys(baseline).length} files)`,
    );
  }

  if (regressionCount > 0) {
    console.error(
      `\nFAIL audit-ui-determinism - ${regressionCount} NEW render-time nondeterminism occurrence(s):`,
    );
    for (const [file, occ] of Object.entries(regressions)) {
      console.error(`  ${file}`);
      for (const o of occ) console.error(`      ${o}`);
    }
    console.error(
      "\nMove the value out of render (into useEffect / a handler / props), pass an explicit 'en-US' locale,\n" +
        "or - if intentional - run `node packages/scripts/audit-ui-determinism.mjs --update-baseline` and commit the baseline.",
    );
    process.exit(1);
  }
  if (!asJson)
    console.log(
      "OK audit-ui-determinism PASSED (no new render-time nondeterminism)",
    );
}

function sortKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

main();
