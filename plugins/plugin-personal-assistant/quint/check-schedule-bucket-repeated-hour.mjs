/** Replay generated device syncs through the production schedule sync. */
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
  path.join(import.meta.dirname, "ScheduleBucketRepeatedHour.qnt"),
);
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const output = testOutputPath("quint-schedule-bucket-repeated-hour");
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
    "--seed=20261115",
    `--max-samples=${modelCase.samples}`,
    // Writing every sample as a trace runs out of heap; 3000 traces already
    // reach all 81 four-sync sequences under this seed (asserted below).
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
const rowsOf = (value) =>
  value["#set"]
    .map((row) => ({
      start: number(row.start),
      end: number(row.end),
      sleepStart: number(row.sleepStart),
      lastActive: number(row.lastActive),
      observed: number(row.observed),
    }))
    .sort((left, right) => left.start - right.start);
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  // Every stored sync adds a step: the sync time and the device's stored
  // rows after it. A trace that stores all four syncs ends a case.
  const syncs = [];
  let stored = 0;
  for (const state of states) {
    if (number(state.syncs) === stored) continue;
    stored = number(state.syncs);
    syncs.push({ at: number(state.now), rows: rowsOf(state.rows) });
  }
  if (syncs.length === 4) {
    cases.set(JSON.stringify(syncs.map((step) => step.at)), { syncs });
  }
}
// 3 first syncs times 3 * 3 * 3 gaps.
assert.equal(cases.size, 81, "Every four-sync sequence must reach conformance");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/schedule-bucket-repeated-hour.test.ts";
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
    env: { ...process.env, ELIZA_SCHEDULE_BUCKET_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Schedule bucket conformance failed. See ${log}`);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "schedule bucket repeated hour returns the sleep start of a row in the repeated hour",
    ...["at 01:30 EDT", "at 01:45 EDT", "at 01:50 EDT"].map(
      (name) =>
        `schedule bucket repeated hour model replays first sync ${name}`,
    ),
  ],
);
console.log(
  `${cases.size} model-generated four-sync sequences (all 81) match ingestScheduleObservations in ${checks.length - 1} first-sync groups, and the merged sleep start is right. Report ${report}`,
);
