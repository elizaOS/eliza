/** Replay generated nights through the production schedule inspection. */
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
assert.equal(model, path.join(import.meta.dirname, "OpenNightDayKey.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const output = testOutputPath("quint-open-night-day-key");
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
    // reach all 20 nights under this seed (asserted below).
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
const WOKEN = 3;
const nights = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  // Every inspection adds one read: its time and the day key it showed.
  const steps = [];
  let reads = 0;
  for (const state of states) {
    if (number(state.reads) > reads) {
      steps.push({ at: number(state.at), day: number(state.shown) });
      reads = number(state.reads);
    }
  }
  const last = states.at(-1);
  if (number(last.phase) !== WOKEN) continue;
  const night = {
    prior: last.prior,
    onset: number(last.onset),
    length: number(last.duration),
    steps,
  };
  nights.set(JSON.stringify([night.prior, night.onset, night.length]), night);
}
// With or without the earlier night, 5 starts and 2 lengths: 20 nights.
assert.equal(nights.size, 20, "Every night must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...nights.keys()].sort().map((key) => nights.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/schedule-open-night-day-key.test.ts";
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "900000",
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
    env: { ...process.env, ELIZA_OPEN_NIGHT_DAY_KEY_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Open night day key conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "the day stays open through one overnight sleep",
    ...["after a night", "first night"].flatMap((prior) =>
      ["14:00", "21:00", "23:00", "00:30", "02:00"].map(
        (clock) => `open night model replays ${prior}, sleep ${clock}`,
      ),
    ),
  ],
);
const reads = [...nights.values()].reduce(
  (sum, night) => sum + night.steps.length,
  0,
);
console.log(
  `${nights.size} model-generated nights (all 20, ${reads} inspections) match inspectSchedule in ${checks.length - 1} groups, and the overnight case keeps the day open until the wake. Report ${report}`,
);
