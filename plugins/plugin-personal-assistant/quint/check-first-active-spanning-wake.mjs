/** Replay generated phone sessions through the production schedule inspection. */
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
assert.equal(
  model,
  path.join(import.meta.dirname, "FirstActiveSpanningWake.qnt"),
);
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const output = testOutputPath("quint-first-active-spanning-wake");
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
    // reach all 16 three-session mornings under this seed (asserted below).
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
const mornings = new Map();
const prefixes = new Set();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  // Every inspection ends a step: the session stored before it and the
  // first active moment the model reports after it.
  const steps = [];
  let pending = false;
  for (const state of states) {
    if (pending && !state.pending) {
      steps.push({
        start: number(state.lastStart),
        end: number(state.lastEnd),
        shown: number(state.shown),
      });
      prefixes.add(JSON.stringify(steps.map((step) => [step.start, step.end])));
    }
    pending = state.pending;
  }
  if (steps.length === 3) {
    mornings.set(JSON.stringify(steps.map((step) => [step.start, step.end])), {
      steps,
    });
  }
}
// 4 first sessions, then 2 gaps for each later session: 4 + 8 + 16 mornings.
assert.equal(prefixes.size, 28, "Every morning must reach conformance");
assert.equal(mornings.size, 16, "Every three-session morning must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...mornings.keys()].sort().map((key) => mornings.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/schedule-first-active-wake.test.ts";
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
    env: { ...process.env, ELIZA_FIRST_ACTIVE_WAKE_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `First active spanning wake conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "first active stays at the wake when phone use spans it",
    ...[
      "starts 06:40 for 20 min",
      "starts 06:40 for 40 min",
      "starts 07:00 for 20 min",
      "starts 07:00 for 40 min",
    ].map((name) => `first active model replays first session ${name}`),
  ],
);
console.log(
  `${mornings.size} model-generated three-session mornings (all 16, covering all ${prefixes.size} session sequences) match inspectSchedule in ${checks.length - 1} first-session groups, and the spanning-wake case stays at the wake. Report ${report}`,
);
