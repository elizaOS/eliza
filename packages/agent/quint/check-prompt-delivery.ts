/** HTTP/SQL trigger suite: selection, host retirement and terminal prompt outcomes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("quint-prompt-delivery");
await mkdir(output, { recursive: true });
const reportPath = path.join(
  await mkdtemp(path.join(output, "run-")),
  "vitest.json",
);
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "packages/agent/vitest.config.ts",
    "packages/agent/test/trigger-schedule-persistence.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
assert.equal(result.status, 0);
assert.equal(result.signal, null);
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.numPassedTests, report.numTotalTests);
const cases = report.testResults.flatMap(
  (suite: { assertionResults: Array<{ fullName: string; status: string }> }) =>
    suite.assertionResults,
);
for (const scenario of ["two-windows", "missing-selected"]) {
  assert.equal(
    cases.filter(
      (test: { fullName: string; status: string }) =>
        test.fullName ===
          `delivers an API Once reply through the persisted owner room (${scenario})` &&
        test.status === "passed",
    ).length,
    1,
  );
}
for (const name of [
  ...["POST", "PUT"].map(
    (method) =>
      `refuses ${method} persistence when the runtime changes during the delivery-room read`,
  ),
  ...["failed", "cancelled", "denied"].map(
    (status) =>
      `records the resolved prompt turn outcome ${status} with prior delivery false`,
  ),
  "records the resolved prompt turn outcome failed with prior delivery true",
  "records the resolved prompt turn outcome completed with prior delivery false",
]) {
  assert.equal(
    cases.filter(
      (test: { fullName: string; status: string }) =>
        test.fullName === name && test.status === "passed",
    ).length,
    1,
  );
}
console.log(
  `Prompt delivery conformance passed ${report.numPassedTests} existing trigger cases. ${reportPath}`,
);
