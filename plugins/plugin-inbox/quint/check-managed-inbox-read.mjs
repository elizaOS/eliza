/** Checks the selected managed aggregate and real check-in paths. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const producer = testOutputPath("quint-managed-inbox");
mkdirSync(producer, { recursive: true });
const directory = mkdtempSync(path.join(producer, "run-"));
const cases = [
  {
    owner: "plugin-inbox",
    file: "plugins/plugin-inbox/test/inbox-aggregate.real-runtime.test.ts",
    names: [
      "InboxDomain on a real runtime uses the host-selected Gmail reader without replaying legacy cached mail",
      "InboxDomain on a real runtime combines managed Gmail with other cached channels without legacy Gmail rows",
      "InboxDomain on a real runtime keeps a failed managed Gmail read visible instead of reporting an empty inbox",
    ],
  },
  {
    owner: "plugin-personal-assistant",
    file: "plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-availability.pglite.test.ts",
    names: [
      "check-in source availability and generation failures includes the current managed Gmail mailbox through the canonical Inbox service",
    ],
  },
];
for (const item of cases) {
  const report = path.join(directory, `${item.owner}.json`);
  const pattern = item.names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const result = spawnSync(
    process.execPath,
    [
      "packages/scripts/run-with-deadline.ts",
      "300000",
      "--",
      process.execPath,
      "packages/scripts/run-vitest.ts",
      "run",
      "--config",
      `plugins/${item.owner}/vitest.config.ts`,
      item.file,
      "--maxWorkers=1",
      "--testNamePattern",
      pattern,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(directory, `${item.owner}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    `Managed Inbox conformance terminated: ${directory}`,
  );
  assert.equal(
    result.status,
    0,
    `Managed Inbox conformance failed: ${directory}`,
  );
  const summary = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(summary.success, true);
  assert.equal(summary.numFailedTests, 0);
  assert.equal(summary.numFailedTestSuites, 0);
  assert.equal(summary.testResults.length, 1);
  assert.equal(
    path.resolve(summary.testResults[0].name),
    path.join(root, item.file),
  );
  const passed = summary.testResults[0].assertionResults.filter(
    (row) => row.status === "passed",
  );
  assert.deepEqual(
    passed.map((row) => row.fullName).sort(),
    [...item.names].sort(),
  );
  for (const row of passed) assert.deepEqual(row.failureMessages, []);
}
console.log(
  `Four selected managed Inbox/check-in cases passed. Evidence ${directory}`,
);
