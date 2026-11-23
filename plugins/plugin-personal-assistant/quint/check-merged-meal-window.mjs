/** Replay generated refresh ticks through the production local schedule refresh. */
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
assert.equal(model, path.join(import.meta.dirname, "MergedMealWindow.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-merged-meal-window");
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
  // Every refresh that has run ends a case: the device's refreshes so far,
  // each with the merged next meal the model shows after it.
  const ticks = [];
  let ran = 0;
  for (const state of states) {
    if (number(state.ticks) === ran) continue;
    ran = number(state.ticks);
    ticks.push({
      at: number(state.now),
      start: number(state.mergedStart),
      end: number(state.mergedEnd),
    });
    cases.set(JSON.stringify(ticks.map((tick) => tick.at)), {
      ticks: ticks.map((tick) => ({ ...tick })),
    });
  }
}
// 3 sequences of one refresh, 6 of two, 12 of three and 24 of four.
assert.equal(cases.size, 45, "Every refresh sequence must reach conformance");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/schedule-merged-meal-window.test.ts";
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
    env: { ...process.env, ELIZA_MERGED_MEAL_WINDOW_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Merged meal window conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "merged meal window shows the lunch window that opened inside the current bucket in the overview",
    ...[
      "on the bucket",
      "10 minutes into a bucket",
      "20 minutes into a bucket",
    ].map((name) => `merged meal window model replays first tick ${name}`),
  ],
);
console.log(
  `${cases.size} model-generated refresh sequences (all 45) match refreshLocalMergedScheduleState in ${checks.length - 1} first-tick groups, and the overview shows the window. Report ${report}`,
);
