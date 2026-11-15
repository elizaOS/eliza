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
  path.join(import.meta.dirname, "CalendarMutationLedger.qnt"),
);

const output = testOutputPath("quint-calendar-mutation-ledger");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const file = "test/calendar-mutation-retry-invalidate.pglite.test.ts";
const required = [
  "ends a refused approval when the retry finds the event changed",
  "ends a refused approval left in executing by older rows",
  "does not invalidate an attempt that is still executing",
  "gives one concurrent claimant the exact receipt and replays it after restart",
  "keeps an orphan blocked after owner confirmation without a receipt",
  "reconciles only the matching operation and persists the exact receipt in both rows",
  "allows a reconciled non-delivery to retry and rejects settlement with the old token",
];
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    file,
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
assert.equal(
  result.signal,
  null,
  `Calendar ledger tests were interrupted: ${log}`,
);
assert.equal(result.status, 0, `Calendar ledger tests failed: ${log}`);
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(calendar, file),
  required,
);
console.log(`Passed ${required.length} local Calendar ledger cases. ${report}`);
