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
const output = testOutputPath("quint-owner-local-timezone");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    "--main=OwnerLocalTimezone",
    "--backend=typescript",
    "--seed=20261112",
    "--max-samples=100",
    "--n-traces=100",
    "--max-steps=2",
    "--invariant=ResolvedClock",
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
    if (!state.resolved) continue;
    const fields = Object.fromEntries(
      [
        "scenario",
        "ownerZone",
        "schedulingZone",
        "runtimeZone",
        "hostZone",
        "selectedZone",
      ].map((key) => [key, Number(state[key]["#bigint"])]),
    );
    fields.hostTravel = state.hostTravel;
    fields.tickTravel = state.tickTravel;
    cases.set(fields.scenario, fields);
  }
}
assert.equal(
  cases.size,
  8,
  "All eight clock and travel scenarios must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.values()].sort((a, b) => a.scenario - b.scenario)),
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
    "plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts",
    "-t",
    "resolves owner-local cron timezone priority",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, ELIZA_OWNER_ZONE_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 180000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Owner-local runtime conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 8);
assert.equal(summary.numFailedTests, 0);
console.log(
  "Eight model-generated timezone cases match the production runner and tick preflight",
);
