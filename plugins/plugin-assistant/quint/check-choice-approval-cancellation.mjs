/** Checks actual authorized choice cancellation, SQLite ownership and generic PGlite dispatch. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const plugin = path.resolve(import.meta.dirname, "..");
const model = path.join(plugin, "quint/ChoiceApprovalCancellation.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "src/integration/choice-schedule.test.ts";
const required = [
  "rejects a damaged choice before worker effects while healthy and repaired choices execute",
  "ABORT confirms owned SQLite cancellation only after deletion and caller settlement",
  "ABORT retains the SQLite approval owner on deletion failure and retries without effects",
  "ABORT refuses an already-claimed SQLite approval without a cancellation receipt",
  "ABORT retains the SQLite approval when its registered owner is unavailable",
];

const output = testOutputPath("quint-choice-approval-cancellation");
mkdirSync(output, { recursive: true });
const run = mkdtempSync(path.join(output, "conformance-"));
const reportFile = path.join(run, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "../../packages/scripts/run-with-deadline.ts",
    "180000",
    "--",
    process.execPath,
    "../../packages/scripts/run-vitest.ts",
    "run",
    test,
    "--maxWorkers=1",
    "--retry=0",
    "--no-cache",
    `--fsModuleCachePath=${path.join(run, "module-cache")}`,
    "--reporter=json",
    `--outputFile=${reportFile}`,
  ],
  { cwd: plugin, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(
  result.status,
  0,
  "Choice cancellation implementation tests failed",
);

const report = JSON.parse(readFileSync(reportFile, "utf8"));
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults.length, 1);
const [file] = report.testResults;
assert.equal(file.name, path.join(plugin, test));
for (const title of required) {
  const matches = file.assertionResults.filter(
    ({ fullName }) => fullName === title,
  );
  assert.equal(
    matches.length,
    1,
    `Missing or duplicated conformance case ${title}`,
  );
  assert.equal(
    matches[0].status,
    "passed",
    `Conformance case did not pass: ${title}`,
  );
}
console.log(
  `Choice cancellation conformance passed all ${required.length} required cases. Report ${reportFile}`,
);
