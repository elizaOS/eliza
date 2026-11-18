/** Bind the guard lifetime model to the existing Hono/proxy admission regressions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "DeferredCredentialDispatch.qnt"),
);
const output = testOutputPath("quint-deferred-credential-dispatch");
mkdirSync(output, { recursive: true });
const report = path.join(mkdtempSync(path.join(output, "run-")), "results.xml");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "240000",
    "--",
    "bun",
    "test",
    "--conditions=eliza-source",
    "packages/cloud/api/__tests__/guarded-paid-proxy-admission.test.ts",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (child.error) throw child.error;
assert.equal(child.signal, null);
assert.equal(child.status, 0, "Guard lifetime implementation checks failed");
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.tests, 6);
assert.equal(summary.executedTests, 6);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
const matches = [
  ...xml.matchAll(
    /<testcase\b[^>]*\bname="deferred credential stays owned through async preflight \(paid work: %s\)"/g,
  ),
];
assert.equal(
  matches.length,
  2,
  "Both paid and refused preflight cases must run",
);
console.log(
  `Guard lifetime: all six existing admission cases passed. Report ${report}`,
);
