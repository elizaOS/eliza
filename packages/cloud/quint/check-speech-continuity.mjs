import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SaxesParser } from "saxes";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/speech_continuity.qnt"),
);
const output = testOutputPath("quint-speech-continuity");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const cases = [
  [
    "host",
    "src/voice/speech-retirement-session.test.ts",
    [
      "paid renewal retains one STT connection and settles each window once",
      ...["quota", "admission", "extension"].map(
        (pending) =>
          `Stop requests provider teardown while renewal waits on ${pending}`,
      ),
      ...["credit", "quota", "legacy"].map(
        (failure) => `failed late renewal ${failure} cleanup remains owned`,
      ),
    ],
  ],
];
for (const [owner, file, names] of cases) {
  const report = path.join(directory, `${owner}.json`);
  const pattern = names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      file,
      "-t",
      `^(${pattern})$`,
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: path.join(root, "packages", owner),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(directory, `${owner}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    `${owner} continuity implementation interrupted`,
  );
  assert.equal(
    result.status,
    0,
    `${owner} continuity implementation failed: ${directory}`,
  );
  const data = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(data.success, true);
  assert.equal(data.numPassedTests, names.length);
  assert.equal(
    data.numFailedTests + data.numTodoTests + data.numFailedTestSuites,
    0,
  );
  assert.equal(data.testResults.length, 1);
  const suite = data.testResults[0];
  assert.equal(
    path.resolve(suite.name),
    path.join(root, "packages", owner, file),
  );
  assert.equal(suite.status, "passed");
  const assertions = suite.assertionResults;
  assert.equal(assertions.length, data.numTotalTests);
  assert.equal(
    new Set(assertions.map((result) => result.fullName)).size,
    assertions.length,
  );
  const passed = [];
  let skipped = 0;
  for (const result of assertions) {
    if (names.includes(result.fullName)) {
      assert.equal(
        result.status,
        "passed",
        `Missing required result: ${result.fullName}`,
      );
      assert.deepEqual(result.failureMessages, []);
      passed.push(result.fullName);
    } else {
      // Vitest reports filtered tests as skipped; older versions used pending.
      assert(
        ["skipped", "pending"].includes(result.status),
        `Unexpected executed test: ${result.fullName}`,
      );
      skipped++;
    }
  }
  assert.deepEqual(passed.toSorted(), names.toSorted());
  assert.equal(data.numPendingTests, skipped);
}
const report = path.join(directory, "ledger.xml");
const ledgerTest =
  "renewed windows must settle before retirement can be confirmed";
const result = spawnSync(
  "bun",
  [
    "--conditions=eliza-source",
    "test",
    "packages/cloud/api/src/speech-retirement-state.test.ts",
    "-t",
    `^${ledgerTest}$`,
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  },
);
writeFileSync(
  path.join(directory, "ledger.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(
  result.signal,
  null,
  "continuity ledger implementation interrupted",
);
assert.equal(
  result.status,
  0,
  `continuity ledger implementation failed: ${directory}`,
);
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.executedTests, 1);
assert.equal(summary.failures + summary.errors, 0);
assert.deepEqual(
  summary.files.map(({ file }) => file),
  ["packages/cloud/api/src/speech-retirement-state.test.ts"],
);
const executed = [];
let testcase;
const parser = new SaxesParser({ xmlns: false });
parser.on("opentag", (tag) => {
  if (tag.name === "testcase")
    testcase = {
      name: tag.attributes.name,
      file: tag.attributes.file,
      skipped: false,
    };
  if (tag.name === "skipped" && testcase) testcase.skipped = true;
});
parser.on("closetag", (tag) => {
  if (tag.name === "testcase" && testcase) {
    if (!testcase.skipped)
      executed.push({ name: testcase.name, file: testcase.file });
    testcase = undefined;
  }
});
parser.write(xml).close();
assert.deepEqual(executed, [
  {
    name: ledgerTest,
    file: "packages/cloud/api/src/speech-retirement-state.test.ts",
  },
]);
