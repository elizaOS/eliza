import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "packages/cloud/quint/speech_continuity.qnt"),
);
const output = testOutputPath("quint-speech-continuity");
mkdirSync(output, { recursive: true });
const cases = [
  [
    "host",
    "src/voice/speech-retirement-session.test.ts",
    "paid renewal retains one STT connection and settles each window once",
  ],
];
for (const [owner, file, name] of cases) {
  const report = path.join(output, `${owner}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      file,
      "-t",
      name,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: path.join(root, "packages", owner),
      env: process.env,
      encoding: "utf8",
    },
  );
  writeFileSync(
    path.join(output, `${owner}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  assert.equal(result.status, 0, `${owner} continuity implementation failed`);
  const data = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(data.numPassedTests, 1);
  assert.equal(data.numFailedTests, 0);
}
const report = path.join(output, "ledger.xml");
const result = spawnSync(
  "bun",
  [
    "--conditions=eliza-source",
    "test",
    "packages/cloud/api/src/speech-retirement-state.test.ts",
    "-t",
    "renewed windows must settle before retirement can be confirmed",
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
  path.join(output, "ledger.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
assert.equal(result.status, 0, "continuity ledger implementation failed");
const summary = parseJunitSummary(readFileSync(report, "utf8"));
assert.equal(summary.executedTests, 1);
assert.equal(summary.failures + summary.errors, 0);
