/** Replay generated escalation requests through the owner escalation policy write. */
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
const model = path.resolve(process.argv[2] ?? "");
assert.equal(model, path.join(import.meta.dirname, "EscalationPlan.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-escalation-plan");
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
const plan = (value) => ({
  inApp: number(value.inApp),
  sms: number(value.sms),
  voice: number(value.voice),
});
const sequences = new Map();
const firstRequests = new Set();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const [saved] = states;
  const start = {
    plan: plan(saved.plan),
    quiet: saved.quiet,
    muted: saved.muted,
  };
  const requests = [];
  let applied = 0;
  for (const state of states.slice(1)) {
    // Asking and stuttering change no stored plan; each applied request does.
    if (number(state.applied) === applied) continue;
    applied = number(state.applied);
    requests.push({
      kind: number(state.last),
      plan: plan(state.plan),
      quiet: state.quiet,
      muted: state.muted,
    });
  }
  if (requests.length === 0) continue;
  firstRequests.add(JSON.stringify({ start, kind: requests[0].kind }));
  const item = { start, requests };
  sequences.set(JSON.stringify(item), item);
}
// 7 saved step sets, with or without quiet hours and a mute policy, each
// followed by one of 4 requests.
assert.equal(
  firstRequests.size,
  112,
  "Every saved plan and first request must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file =
  "plugins/plugin-personal-assistant/src/actions/escalation-plan-model.pglite.integration.test.ts";
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "600000",
    "--",
    process.execPath,
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
    file,
    "--maxWorkers=1",
    "--retry=0",
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ELIZA_ESCALATION_PLAN_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Escalation plan conformance failed. See ${log}`);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, file),
  [
    "call after 30 minutes",
    "call after 30 minutes with replace",
    "an sms step at 15 minutes",
    "call after a 20 minute timeout",
  ].map(
    (name) =>
      `escalation plan model replays the escalation plan model when the first request is ${name}`,
  ),
);
console.log(
  `${sequences.size} model-generated request sequences (all 112 saved plans and first requests) match the owner escalation policy write in ${checks.length} groups. Report ${report}`,
);
