/** Replay generated send-consent replies through the draft send action. */
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
assert.equal(model, path.join(import.meta.dirname, "SendConsentReply.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-send-consent-reply");
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
const reply = (value) => ({
  extra: number(value.extra),
  capital: value.capital,
  comma: value.comma,
  mark: number(value.mark),
});
const sequences = new Map();
const firstReplies = new Set();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const replies = [];
  let previous = "";
  for (const state of states.slice(1)) {
    // The first answer, then the later reply once there is one.
    const later = number(state.later.extra) >= 0;
    if (number(state.first.extra) < 0) continue;
    const step = {
      reply: reply(later ? state.later : state.first),
      outcome: number(state.outcome),
      sends: number(state.sends),
    };
    const key = JSON.stringify({ later, ...step });
    // A stutter changes nothing.
    if (key === previous) continue;
    previous = key;
    replies.push(step);
  }
  if (replies.length === 0) continue;
  firstReplies.add(JSON.stringify(replies[0].reply));
  sequences.set(JSON.stringify(replies), { replies });
}
// "yes" in 6 written forms, "yes please" and "yes later" in 12 each.
assert.equal(
  firstReplies.size,
  30,
  "Every written first answer must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file =
  "src/features/messaging/triage/actions/send-consent-reply-model.test.ts";
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    file,
    "--maxWorkers=1",
    "--retry=0",
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: plugin,
    encoding: "utf8",
    env: { ...process.env, ELIZA_SEND_CONSENT_REPLY_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Send consent reply conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  ["nothing", "please", "later"].map(
    (word) =>
      `send consent reply model replays the send consent reply model when yes is followed by ${word}`,
  ),
);
console.log(
  `${sequences.size} model-generated reply sequences (all 30 written first answers) match the draft send action in ${checks.length} groups. Report ${report}`,
);
