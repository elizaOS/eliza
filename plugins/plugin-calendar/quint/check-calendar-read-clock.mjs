import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.config.ts",
    "plugins/plugin-personal-assistant/test/calendar-action-effect-receipts.pglite.test.ts",
    "-t",
    "aliased read bounds|elapsed daily feed",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const briefing = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.config.ts",
    "plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-availability.pglite.test.ts",
    "-t",
    "canonical Calendar feed|ordinary Gmail",
  ],
  { stdio: "inherit" },
);
if (briefing.error) throw briefing.error;
if (briefing.status !== 0) process.exit(briefing.status ?? 1);

const output = testOutputPath("quint-calendar-selected-read");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
function checkReadSuite(reportName, file, requiredNames) {
  const report = path.join(directory, reportName);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
      ),
      "run",
      "--config",
      "vitest.config.ts",
      file,
      "--cache=false",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    `Calendar conformance was interrupted: ${file}`,
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  requireVitestConformance(
    JSON.parse(readFileSync(report, "utf8")),
    path.join(root, file),
    requiredNames,
  );
}

checkReadSuite("selected.json", "src/actions/calendar-read-selected.test.ts", [
  "current selected canonical Calendar read reads a selected Google event through second-precision filters and emits its versioned receipt",
  "current selected canonical Calendar read refuses a selection replaced while its authorized feed read is pending",
  "current selected canonical Calendar read supplies the computed weekday for an all-day selected event",
  "current selected canonical Calendar read keeps the whole timed selected event and computes its date in America/Los_Angeles",
  "current selected canonical Calendar read keeps the whole timed selected event and computes its date in Pacific/Kiritimati",
  "current selected canonical Calendar read keeps the whole timed selected event and computes its date in UTC",
  "current selected canonical Calendar read preserves the all-day civil date when its canonical timestamp has an offset",
  "current selected canonical Calendar read refuses wrong-owner without returning record evidence",
  "current selected canonical Calendar read refuses wrong-view without returning record evidence",
  "current selected canonical Calendar read refuses sensitive without returning record evidence",
  "current selected canonical Calendar read refuses native-selection without returning record evidence",
  "current selected canonical Calendar read refuses stale-revision without returning record evidence",
  "current selected canonical Calendar read refuses wrong-source without returning record evidence",
  "current selected canonical Calendar read refuses revoked-source without returning record evidence",
  "current selected canonical Calendar read refuses partial-feed without returning record evidence",
  "current selected canonical Calendar read refuses missing-event without returning record evidence",
  "current selected canonical Calendar read refuses changed-event without returning record evidence",
  "current selected canonical Calendar read refuses duplicate-event without returning record evidence",
  "current selected canonical Calendar read binds only the host's current target and refuses a model-supplied target",
]);
checkReadSuite(
  "availability.json",
  "src/actions/calendar-availability.test.ts",
  [
    "proposes only the 9:30–10:00 Pacific gap from the exact bounded owner feed",
    "uses the same snapshot to reject a claim that the full interval is free",
    "rejects an evening end for a morning-only request before reading Calendar",
    'rejects an over-long window for "Am I free tomorrow morning?"',
    'rejects an over-long window for "Do I have 20 minutes tomorrow morning"',
    'rejects an over-long window for "Find me time for a call tomorrow morning."',
    'rejects an over-long window for "Am I free tomorrow morning until noon?"',
    'rejects an over-long window for "Am I free tomorrow morning through 12:00 PM?"',
    "rejects a morning window that starts before tomorrow",
    "accepts a morning window from tomorrow's midnight through noon",
    "reads the window for a wider request: Am I free tomorrow morning or afternoon?",
    "reads the window for a wider request: Check today or tomorrow morning.",
    "reads the window for a wider request: Do I have time after tomorrow morning?",
    "reads the window for a wider request: Is Friday or tomorrow morning free?",
    "recognises only a tomorrow-morning-only request",
    "does not substitute the runtime calendar for a selected device source",
    "does not infer a free slot when one source is stale",
    "rejects an otherwise complete feed belonging to a different owner request",
  ].map((name) => `standalone Calendar availability ${name}`),
);

console.log(
  `Selected Calendar reads and availability cases passed without skips. Evidence ${directory}`,
);

const creationReport = path.join(directory, "creation-clock.json");
const creation = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "--config",
    "vitest.config.ts",
    "--maxWorkers=1",
    "test/eliza-calendar.pglite.test.ts",
    "-t",
    "current client clock|past start on a stated date",
    "--reporter=json",
    `--outputFile=${creationReport}`,
  ],
  { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" },
);
if (creation.error) throw creation.error;
if (creation.status !== 0) process.exit(creation.status ?? 1);
const creationResult = JSON.parse(readFileSync(creationReport, "utf8"));
assert.equal(creationResult.success, true);
assert.equal(creationResult.numFailedTests, 0);
assert.equal(creationResult.numFailedTestSuites, 0);
assert.equal(creationResult.numTodoTests, 0);
const creationCases = creationResult.testResults.flatMap(
  (file) => file.assertionResults,
);
const statedDate = "past start on a stated date (real PGlite)";
const requiredCreation = [
  "built-in Eliza calendar (real PGlite) creates an unqualified local-time event in the current client clock instead of the server clock",
  ...[
    "creates an explicitly requested time earlier today without allowPast",
    "still asks before creating a past start with no stated date",
    "still asks before creating a past start with a bare weekday",
    "stores the stated future day for Korean year",
    "stores the stated future day for Korean next year",
    "stores the stated future day for Chinese next year",
    "still asks before creating a yearless date that passed earlier this year",
    "still asks before creating an explicit current-year date that passed earlier this year",
  ].map((name) => `${statedDate} ${name}`),
];
// The rest of the database suite is deliberately filtered here and has its
// separate full-package test run.
assert.equal(creationResult.numPassedTests, requiredCreation.length);
assert.equal(
  creationResult.numPendingTests,
  creationCases.length - requiredCreation.length,
);
const ranCreation = creationCases.filter((test) => test.status !== "skipped");
assert.deepEqual(
  ranCreation.map((test) => test.fullName).sort(),
  requiredCreation.sort(),
);
for (const test of ranCreation) {
  assert.equal(test.status, "passed", test.fullName);
  assert.deepEqual(test.failureMessages, []);
}
console.log(
  `Nine exact Calendar creation and date cases passed. Evidence ${directory}`,
);
