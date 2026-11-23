/** Replay generated days of phone use through the production schedule inspection. */
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
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const plugin = path.resolve(import.meta.dirname, "..");
const model = path.resolve(process.argv[2] ?? "");
assert.equal(model, path.join(import.meta.dirname, "NextMealDinnerWindow.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const output = testOutputPath("quint-next-meal-dinner-window");
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
    "--seed=20261116",
    `--max-samples=${modelCase.samples}`,
    // Writing every sample as a trace is not needed; 3000 traces already
    // reach all 4 full days under this seed (asserted below).
    `--n-traces=${TRACES}`,
    `--max-steps=${modelCase.maxSteps}`,
    "--invariants",
    ...modelCase.invariants,
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" },
);
const number = (value) => Number(value["#bigint"]);
const days = new Map();
const prefixes = new Set();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  // Every inspection ends a step: the hour stored before it and the next
  // meal the model reports after it.
  const steps = [];
  let pending = false;
  let last = null;
  for (const state of states) {
    if (pending && !state.pending) {
      steps.push({
        hour: number(state.clock),
        shown: state.shown === "none" ? null : state.shown,
      });
      prefixes.add(
        JSON.stringify([state.lunchEaten, state.dinnerEaten, steps.length]),
      );
      last = state;
    }
    pending = state.pending;
  }
  if (last && steps.length === 15) {
    const key = JSON.stringify([last.lunchEaten, last.dinnerEaten]);
    const day = { lunch: last.lunchEaten, dinner: last.dinnerEaten, steps };
    const seen = days.get(key);
    if (seen) assert.deepEqual(seen, day, "Each day must report one sequence");
    days.set(key, day);
  }
}
// 15 inspections; lunch splits the days from 13:00 and dinner from 19:00:
// 4 + 6 * 2 + 5 * 4 hour sequences.
assert.equal(prefixes.size, 36, "Every hour sequence must reach conformance");
assert.equal(days.size, 4, "Every full day must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...days.keys()].sort().map((key) => days.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/schedule-next-meal-dinner-window.test.ts";
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "600000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    file,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: plugin,
    encoding: "utf8",
    env: { ...process.env, ELIZA_NEXT_MEAL_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Next meal conformance failed. See ${log}`);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "next meal is dinner once a skipped lunch meets the dinner window",
    ...[
      "lunch eaten, dinner eaten",
      "lunch eaten, dinner skipped",
      "lunch skipped, dinner eaten",
      "lunch skipped, dinner skipped",
    ].map((name) => `next meal model replays ${name}`),
  ],
);
console.log(
  `${days.size} model-generated days (all 4, covering all ${prefixes.size} hour sequences) match inspectSchedule in ${checks.length - 1} day groups, and the skipped-lunch case reports dinner at 19:00. Report ${report}`,
);
