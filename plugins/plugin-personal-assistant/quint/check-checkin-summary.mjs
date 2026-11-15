import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2]);

const output = testOutputPath("quint-checkin-summary");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    "--main=CheckinSummary",
    "--backend=typescript",
    "--seed=20261112",
    "--max-samples=100",
    "--n-traces=100",
    "--max-steps=4",
    "--invariant=ValidSummaryOnly",
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" },
);
const cases = new Map();
for (const file of readdirSync(directory)) {
  for (const state of JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states) {
    const phase = Number(state.phase["#bigint"]);
    if (phase !== 3 && phase !== 4) continue;
    const fields = {
      outcome: Number(state.outcome["#bigint"]),
      called: state.called,
      writes: Number(state.writes["#bigint"]),
    };
    cases.set(fields.outcome, fields);
  }
}
assert.equal(cases.size, 6, "All six summary outcomes must reach conformance");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.values()].sort((a, b) => a.outcome - b.outcome)),
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.checkin.config.ts",
    "plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-availability.pglite.test.ts",
    "-t",
    "matches the generated summary persistence outcome",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, ELIZA_CHECKIN_SUMMARY_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 180000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Summary runtime conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 6);
assert.equal(summary.numFailedTests, 0);
console.log(
  "Six model-generated summary cases match the production service and report store",
);

const clockReport = path.join(directory, "calendar-clock.json");
const clockResult = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.checkin.config.ts",
    "-t",
    "does not report old Google cache refreshes|keeps valid Calendar rows",
    "--reporter=json",
    `--outputFile=${clockReport}`,
  ],
  { cwd: root, stdio: "inherit", timeout: 180000 },
);
if (clockResult.error) throw clockResult.error;
assert.equal(clockResult.status, 0, "Calendar source-clock conformance failed");
const clockResultData = JSON.parse(readFileSync(clockReport, "utf8"));
assert.equal(clockResultData.success, true);
assert.equal(clockResultData.numFailedTests, 0);
assert.equal(clockResultData.numFailedTestSuites, 0);
assert.equal(clockResultData.numTodoTests, 0);
assert.equal(clockResultData.numPassedTests, 2);
assert.equal(clockResultData.testResults.length, 1);
const clockFile = clockResultData.testResults[0];
assert.equal(
  path.resolve(clockFile.name),
  path.join(
    root,
    "plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-availability.pglite.test.ts",
  ),
);
const requiredClockNames = new Set([
  "check-in source availability and generation failures does not report old Google cache refreshes as recent Calendar changes",
  "check-in source availability and generation failures keeps valid Calendar rows when another cached row has unreadable metadata",
]);
for (const test of clockFile.assertionResults) {
  if (requiredClockNames.delete(test.fullName)) {
    assert.equal(test.status, "passed");
    assert.deepEqual(test.failureMessages, []);
  } else assert.equal(test.status, "skipped");
}
assert.equal(requiredClockNames.size, 0, "Missing Calendar clock scenario");
assert.equal(
  clockResultData.numPendingTests,
  clockFile.assertionResults.length - 2,
);
console.log(
  "Calendar provider-clock cases passed against the real report collector",
);
