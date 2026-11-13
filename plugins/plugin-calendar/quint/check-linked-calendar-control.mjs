/** Replay the local PGlite control and dispatch transitions named by the model. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const calendar = path.resolve(import.meta.dirname, "..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "LinkedCalendarControl.qnt"),
);

const suite = "durable linked calendar review";
const required = [
  "returns one durable receipt for concurrent retries and rejects changed request reuse",
  "rolls back the control change if its receipt cannot be persisted",
  "replays after restart but refuses to describe a superseded review as current",
  "exposes pending work without its receipt and returns a conflict for a blocked owner change",
  "rejects resume until a destination is selected and rejects replacement while active",
  "retains the paused destination and revision after closing and reopening the database",
  "blocks new dispatch, destination change and resume until an admitted operation settles",
  "settles recovery only against the paused revision and invalidates old resume reviews",
  "serializes a pause racing admission across independent repository instances",
  "allows only one concurrent review and rejects a stale resume",
  "preserves pending create, update and delete records when pausing and reviewing a replacement",
];
const reportNames = new Set(required.map((name) => `${suite} ${name}`));
const selector = required.map((name) => RegExp.escape(`${suite} > ${name}`));
const output = testOutputPath("quint-linked-calendar-control");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const file = "src/service/linked-calendar-control.test.ts";
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "240000",
    "--",
    process.execPath,
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    file,
    "-t",
    `^(?:${selector.join("|")})$`,
    "--maxWorkers=1",
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: calendar, encoding: "utf8" },
);
const log = path.join(directory, "vitest.log");
writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Calendar control tests interrupted: ${log}`);
assert.equal(result.status, 0, `Calendar control tests failed: ${log}`);

const results = JSON.parse(readFileSync(report, "utf8"));
const unselected = [];
for (const suiteResult of results.testResults) {
  for (const test of suiteResult.assertionResults) {
    if (!reportNames.has(test.fullName)) {
      // Vitest 5 reports a filtered test as `skipped`. The shared verifier
      // calls this status `pending`. Never normalize a selected test.
      assert.equal(
        test.status,
        "skipped",
        `Unexpected test ran: ${test.fullName}`,
      );
      test.status = "pending";
      unselected.push(test.fullName);
    }
  }
}
requireVitestConformance(
  results,
  path.join(calendar, file),
  [...reportNames, ...unselected],
  unselected,
);
console.log(
  `Passed ${required.length} local Calendar control cases. ${report}`,
);
