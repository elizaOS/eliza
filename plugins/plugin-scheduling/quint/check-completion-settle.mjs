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
// check-quint.ts checks for this model, so a trace that settles twice stops
// the run instead of becoming an expected case.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-completion-settle");
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
const byScan = (value) =>
  Object.fromEntries(
    value["#map"].map(([scan, entry]) => [
      String(number(scan)),
      typeof entry === "string" ? entry : number(entry),
    ]),
  );
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const last = states.at(-1);
  const phase = byScan(last.phase);
  if (
    !Object.values(phase).every((value) =>
      ["completed", "raced", "terminal"].includes(value),
    )
  ) {
    continue;
  }
  const readAt = byScan(last.readAt);
  const commitAt = byScan(last.commitAt);
  const order = [
    ...Object.entries(readAt).map(([scan, at]) => [at, `r${scan}`]),
    ...Object.entries(commitAt).map(([scan, at]) => [at, `c${scan}`]),
  ]
    .filter(([at]) => at > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([, event]) => event);
  cases.set(order.join(" "), {
    order,
    phase,
    children: number(last.children),
    completedLogs: number(last.completedLogs),
  });
}
assert.equal(
  cases.size,
  6,
  "All six read/commit interleavings of the two reply scans must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify(
    [...cases.values()].sort((a, b) =>
      a.order.join(" ").localeCompare(b.order.join(" ")),
    ),
  ),
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    "src/scheduled-task/runner-completion-settle.test.ts",
    "-t",
    "replays the completion settlement model through the runner",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "plugins/plugin-scheduling"),
    env: { ...process.env, ELIZA_COMPLETION_SETTLE_MODEL_CASES: input },
    stdio: "inherit",
    timeout: 180000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Completion settlement conformance failed");
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.numPassedTests, 1);
assert.equal(summary.numFailedTests, 0);
console.log(
  "Six model-generated reply-scan interleavings match the production runner",
);
