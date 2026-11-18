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
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-pending-occurrence");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
    "run",
    model,
    `--main=${modelCase.main}`,
    `--init=${modelCase.init}`,
    `--step=${modelCase.step}`,
    "--backend=typescript",
    "--seed=20261114",
    `--max-samples=${modelCase.samples}`,
    `--n-traces=${modelCase.samples}`,
    `--max-steps=${modelCase.maxSteps}`,
    "--invariants",
    ...modelCase.invariants,
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" },
);
const number = (value) => Number(value["#bigint"]);
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  if (number(states.at(-1).day) <= 3) continue;
  const steps = [];
  for (const state of states.slice(1)) {
    if (state.events.length === steps.length) continue;
    steps.push({
      event: state.events.at(-1),
      status: state.status,
      dispatched: state.dispatched.map(number),
    });
  }
  cases.set(steps.map((step) => step.event).join(" "), steps);
}
// Each day the owner may leave the row alone, skip, complete or dismiss it
// while it is scheduled or fired: 13 sequences start with a fire, 4 with a
// skip, 4 with a complete and 1 with a dismiss.
assert.equal(
  cases.size,
  22,
  "Every owner verb/tick sequence over three occurrences must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    "src/scheduled-task/runner-pending-occurrence.test.ts",
    "-t",
    "replays the pending occurrence model through the runner",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "plugins/plugin-scheduling"),
    env: { ...process.env, ELIZA_PENDING_OCCURRENCE_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 180000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Pending occurrence conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 2);
assert.equal(summary.numFailedTests, 0);
console.log(
  "22 model-generated owner verb sequences match the production runner for cron and during_window triggers",
);
