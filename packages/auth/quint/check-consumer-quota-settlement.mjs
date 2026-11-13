/** Checks quota and receipt bookkeeping against real scratch storage. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const auth = fileURLToPath(new URL("../", import.meta.url));
const suite = "src/accounts/account-pool-consumer-metering.test.ts";
const titles = [
  "reconciles an overlapping reservation against its actual recorded usage",
  "persists quota reservations across process-local state resets",
  "serializes concurrent totals updates without losing records",
];
const tests = titles.map((name) => `quota and totals ${name}`);
const output = testOutputPath("quint-consumer-quota-settlement");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.json");
const result = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    suite,
    "--testNamePattern",
    `(?:${titles.join("|")})$`,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: auth, encoding: "utf8", timeout: 360_000 },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(result.signal, null);
assert.equal(
  result.status,
  0,
  `Quota conformance failed. Evidence ${directory}`,
);
const evidence = JSON.parse(await readFile(report, "utf8"));
assert.equal(evidence.success, true);
assert.equal(evidence.numFailedTests, 0);
assert.equal(evidence.numFailedTestSuites, 0);
assert.equal(evidence.numPassedTests, tests.length);
assert.equal(evidence.testResults.length, 1);
const file = evidence.testResults[0];
assert.equal(path.resolve(file.name), path.join(auth, suite));
const passed = file.assertionResults.filter((item) => item.status === "passed");
assert.deepEqual(passed.map((item) => item.fullName).sort(), tests.toSorted());
assert(passed.every((item) => item.failureMessages.length === 0));
console.log(
  `Quota bookkeeping passed ${passed.length} named cases. Evidence ${directory}`,
);
