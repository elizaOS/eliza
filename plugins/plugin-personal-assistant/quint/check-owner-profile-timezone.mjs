import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2]);
const output = testOutputPath("quint-owner-profile-timezone");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    "--main=OwnerProfileTimezone",
    "--backend=typescript",
    "--seed=20261113",
    "--max-samples=100",
    "--n-traces=100",
    "--max-steps=3",
    "--invariant=CalendarReadsStoredZone",
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" },
);
const cases = new Map();
for (const file of readdirSync(directory)) {
  for (const state of JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states) {
    if (Number(state.phase["#bigint"]) !== 2) continue;
    const fields = Object.fromEntries(
      ["prior", "statement", "stored", "readZone"].map((key) => [
        key,
        Number(state[key]["#bigint"]),
      ]),
    );
    cases.set(`${fields.prior}:${fields.statement}`, fields);
  }
}
assert.equal(
  cases.size,
  8,
  "All eight stored-zone and statement scenarios must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify(
    [...cases.values()].sort(
      (a, b) => a.prior - b.prior || a.statement - b.statement,
    ),
  ),
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.config.ts",
    "plugins/plugin-personal-assistant/src/lifeops/owner/profile-extraction-evaluator.pglite.test.ts",
    "-t",
    "matches the generated owner timezone outcome",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, ELIZA_OWNER_PROFILE_TIMEZONE_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 600000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Owner timezone runtime conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 8);
assert.equal(summary.numFailedTests, 0);
console.log(
  "Eight model-generated owner timezone cases match the production evaluator and calendar zone",
);
