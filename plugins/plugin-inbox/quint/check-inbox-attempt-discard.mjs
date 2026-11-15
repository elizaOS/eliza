/** Requires real journal/controller discard and ownership cases over controlled provider/storage ports. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
if (process.argv[2])
  assert.equal(
    path.resolve(process.argv[2]),
    path.join(import.meta.dirname, "InboxAttemptDiscard.qnt"),
  );
assert(process.argv.length <= 3);
const output = testOutputPath("quint-inbox-attempt-discard");
mkdirSync(output, { recursive: true });
const run = mkdtempSync(path.join(output, "run-"));
const report = path.join(run, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "../../packages/scripts/run-with-deadline.ts",
    "180000",
    "--",
    process.execPath,
    "../../packages/scripts/run-vitest.ts",
    "run",
    "test/mailbox/operation-journal.test.ts",
    "test/mailbox/review-controller.test.ts",
    "--maxWorkers=1",
    "--retry=0",
    "--no-cache",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: path.join(root, "plugins/plugin-inbox"), stdio: "inherit" },
);
if (result.error) throw result.error;
assert.equal(result.signal, null);
assert.equal(result.status, 0, report);
const data = JSON.parse(readFileSync(report, "utf8"));
assert.equal(data.success, true);
for (const name of ["numFailedTests", "numPendingTests", "numTodoTests"])
  assert.equal(data[name], 0);
const tests = data.testResults.flatMap((file) => file.assertionResults);
for (const title of [
  "InboxOperation discards an attempted operation only while the provider reports it as prepared",
  "retains an attempted operation when its owner retires during the discard receipt read",
  "retains an attempted operation when its discard write conflicts",
  "createMailReviewController lets the owner discard an attempted send that Gmail reports as not sent",
]) {
  const matched = tests.filter((test) => test.fullName === title);
  assert.equal(matched.length, 1, title);
  assert.equal(matched[0].status, "passed", title);
}
console.log(
  `Inbox discard conformance passed ${data.numPassedTests} real-source cases. Report ${report}`,
);
