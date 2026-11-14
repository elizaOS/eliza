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
  path.join(import.meta.dirname, "CalendarWatchSyncSettlement.qnt"),
);

const output = testOutputPath("quint-calendar-watch-sync-settlement");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const file = "test/google-calendar-watch.pglite.test.ts";
const suite = "Google Calendar push lifecycle";
const required = [
  "keeps the replacement lease when an older scheduled sync fails",
  "keeps a stopped channel terminal when its old scheduled sync fails",
  "keeps a pending stop when its scheduled sync fails with the old lease token",
  "records a terminal failure while the scheduled sync still owns the lease",
];
const outsideProjection = [
  "installs one maintenance task when Calendar starts before the deferred runner",
  "does not create or accept push channels when the webhook is disabled",
  "binds and processes the sync notification that arrives before the watch response",
  "survives a runtime restart and ignores duplicate or out-of-order message numbers",
  "processes a notification that proxies relay with any X-Forwarded-Proto chain",
  "replays the forwarded proto model through the Google Calendar webhook",
  "does not mutate durable channel state for an invalid capability token",
  "rejects stale tokens, wrong resources, and changed account bindings",
  "fails visibly instead of fabricating a cursor when durable channel state is malformed",
  "returns 503 without advancing, recovers through ScheduledTask, and performs a controlled 410 full resync",
  "maintenance recreates a structural retry for a stranded pending notification",
  "renews with overlap and stops the old channel through ScheduledTask dispatch",
  "revokes live channels through the runner before connector-account deletion",
];
// Vitest selects paths with ` > ` and writes space-separated names in JSON.
const selector = required.map((name) => RegExp.escape(`${suite} > ${name}`));
const reportName = (name) => `${suite} ${name}`;
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
assert.equal(
  result.signal,
  null,
  `Calendar watch tests were interrupted: ${log}`,
);
assert.equal(result.status, 0, `Calendar watch tests failed: ${log}`);

const results = JSON.parse(readFileSync(report, "utf8"));
// Vitest 5 labels tests excluded by its name filter `skipped`. The shared
// verifier expects the same status under its older `pending` spelling.
for (const suiteResult of results.testResults) {
  for (const test of suiteResult.assertionResults) {
    if (test.status === "skipped") test.status = "pending";
  }
}
requireVitestConformance(
  results,
  path.join(calendar, file),
  [...required, ...outsideProjection].map(reportName),
  outsideProjection.map(reportName),
);
console.log(
  `Passed ${required.length} internal Calendar watch cases. ${report}`,
);
