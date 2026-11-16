/** Replay generated HID samples through the production schedule inspection. */
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
assert.equal(model, path.join(import.meta.dirname, "HidIdleSharedDevice.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const output = testOutputPath("quint-hid-idle-shared-device");
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
    // reach all 16 cases under this seed (asserted below).
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
const INSPECTED = 3;
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const last = states.at(-1);
  if (number(last.phase) !== INSPECTED) continue;
  const hasSample = last.hasSample;
  const item = {
    hasSample,
    // Without a sample the idle time and age are not replayed.
    idle: hasSample ? number(last.idle) : 0,
    age: hasSample ? number(last.age) : 0,
    discounted: last.discounted,
  };
  const key = JSON.stringify([item.hasSample, item.idle, item.age]);
  const seen = cases.get(key);
  if (seen) assert.equal(seen.discounted, item.discounted, key);
  cases.set(key, item);
}
// No sample, or 5 idle times at 3 ages: 16 cases.
assert.equal(cases.size, 16, "Every case must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/schedule-hid-idle-shared-device.test.ts";
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
    env: { ...process.env, ELIZA_HID_IDLE_SHARED_DEVICE_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `HID idle shared-device conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "an idle HID sample keeps the shared-device discount",
    "HID idle model replays no HID sample",
    ...[5, 60, 61, 1500, 10800].map(
      (idle) => `HID idle model replays HID idle ${idle}s`,
    ),
  ],
);
const discounted = [...cases.values()].filter((item) => item.discounted);
console.log(
  `${cases.size} model-generated cases (all 16, ${discounted.length} discounted) match inspectSchedule in ${checks.length - 1} groups, and an idle HID sample keeps the shared-device discount. Report ${report}`,
);
