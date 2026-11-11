/** Exercise the retained domain purchase and its ledger constraints in PGlite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "DomainPurchaseAttempt.qnt"),
  "Domain purchase conformance requires its own model path",
);
const suite =
  "packages/cloud/shared/src/db/repositories/__tests__/domain-purchase-attempts.pglite.test.ts";
const required = [
  "single-flights concurrent creation and rejects a different app tenant",
  "pins the registration term at creation and rejects missing or mutated terms",
  "pins one quote and lets exactly one caller claim registrar start",
  "rejects cross-tenant and wrong-amount charge attachments in SQL",
  "lets a new purchase start after an uncharged failure's replay window",
  "keeps an expired attempt that charged",
  "surfaces an expired charged attempt to the durable reconciler",
  "reclaims an expired provider lease once and binds the exact refund",
  "binds completion to the exact tenant-owned managed domain",
];
const output = testOutputPath("quint-domain-purchase-attempt");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=60000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    suite,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Domain purchase implementation checks failed");

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, 14]],
  "The complete domain purchase implementation suite must execute",
);
const names = new Set(
  [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)].map((match) =>
    match[1].replaceAll("&apos;", "'"),
  ),
);
for (const name of required) {
  assert(names.has(name), `Missing required domain purchase case: ${name}`);
}
console.log(
  `Domain purchase passed ${required.length} required checks within ${summary.executedTests} PGlite tests. Report ${report}`,
);
