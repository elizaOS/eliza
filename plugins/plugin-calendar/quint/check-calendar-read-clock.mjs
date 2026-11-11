import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

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

const selected = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "--config",
    "vitest.config.ts",
    "src/actions/calendar-read-selected.test.ts",
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  },
);
if (selected.error) throw selected.error;
if (selected.status !== 0) process.exit(selected.status ?? 1);

const output = testOutputPath("quint-calendar-create-clock");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
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
    "current client clock",
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
assert.equal(creationResult.numPassedTests, 1);
const creationCases = creationResult.testResults.flatMap(
  (file) => file.assertionResults,
);
const clockCase = creationCases.filter(
  (result) =>
    result.fullName ===
    "built-in Eliza calendar (real PGlite) creates an unqualified local-time event in the current client clock instead of the server clock",
);
assert.equal(clockCase.length, 1);
assert.equal(clockCase[0].status, "passed");
assert.deepEqual(clockCase[0].failureMessages, []);
// This command selects one clock regression. The rest of this broad database
// suite is deliberately filtered and has its separate full-package test run.
assert.equal(creationResult.numPendingTests, creationCases.length - 1);
assert(
  creationCases.every(
    (result) =>
      result === clockCase[0] || ["pending", "skipped"].includes(result.status),
  ),
);
