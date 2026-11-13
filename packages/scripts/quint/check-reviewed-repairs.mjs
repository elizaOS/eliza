/** Runs existing real implementation checks for the reviewed repair models. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.basename(process.argv[2] ?? "");
const suites = {
  "LegacyTrajectoryMigration.qnt": {
    cwd: "plugins/plugin-assistant",
    file: "src/features/trajectories/legacy-trajectory-migration.pglite.test.ts",
    match: "preserves complete legacy steps",
    names: [
      "preserves complete legacy steps when the canonical row store first opens",
      "preserves complete legacy steps through a failed migration and retry",
    ],
  },
  "TurnCancellation.qnt": {
    cwd: "packages/core",
    file: "test/use-model-cancellation.test.ts",
    match: "cancels a nested scope with|does not give a nested scope",
    names: [
      "cancels a nested scope with no context when the turn aborts",
      "cancels a nested scope with a same-turn context without a signal when the turn aborts",
      "does not give a nested scope for another turn this turn's signal",
    ].map((name) => `AgentRuntime.useModel cancellation ${name}`),
  },
  "BackupPublication.qnt": {
    cwd: "plugins/plugin-sqlite",
    file: "adapter.test.ts",
    match: "restores a standalone backup",
    names: [
      "durable SQLite agent adapter restores a standalone backup and rejects conflicting owners and unsupported schemas",
    ],
  },
};
const suite = suites[model];
assert(suite, `Unsupported repair model: ${model}`);
const output = testOutputPath("quint-reviewed-repairs");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    suite.file,
    "-t",
    suite.match,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: path.join(root, suite.cwd), encoding: "utf8", timeout: 180000 },
);
writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.status, 0, `Repair conformance failed. See ${log}`);
const data = JSON.parse(readFileSync(report, "utf8"));
// Vitest reports unselected cases as pending; require the exact selected tests
// and reject failed/duplicated selected results without relabeling those skips.
const selected = data.testResults
  .flatMap((file) => file.assertionResults)
  .filter((test) => test.status !== "pending" && test.status !== "skipped");
assert.deepEqual(
  selected.map((test) => test.fullName).sort(),
  [...suite.names].sort(),
);
for (const test of selected) assert.equal(test.status, "passed");
assert.equal(data.success, true);
assert.equal(data.numFailedTests, 0);
assert.equal(data.numFailedTestSuites, 0);
assert.equal(data.numPassedTests, suite.names.length);
console.log(
  `Passed ${selected.length} named implementation checks for ${model}. Report ${report}`,
);
