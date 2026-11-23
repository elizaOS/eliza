/** Replay generated contact emails through CONTACT create and a Gmail MESSAGE send. */
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
assert.equal(model, path.join(import.meta.dirname, "GmailContactEmail.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const output = testOutputPath("quint-gmail-contact-email");
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
    // reach all 36 cases under this seed (asserted below).
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
const SENT = 2;
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const last = states.at(-1);
  if (number(last.phase) !== SENT) continue;
  const item = {
    claims: last.claims,
    contact: number(last.contact),
    named: number(last.named),
    shaped: number(last.shaped),
    delivered: number(last.delivered),
    refusal: number(last.refusal),
  };
  const key = JSON.stringify([
    item.claims,
    item.contact,
    item.named,
    item.shaped,
  ]);
  const seen = cases.get(key);
  if (seen) assert.deepEqual(seen, item, key);
  cases.set(key, item);
}
// 2 modes x 3 contact emails x 3 named component emails x 2 shaped values.
assert.equal(cases.size, 36, "Every case must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "src/gmail-contact-email.real.test.ts";
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
    env: { ...process.env, ELIZA_GMAIL_CONTACT_EMAIL_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Gmail contact email conformance failed. See ${log}`);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "emails a contact at the email CONTACT stored",
    ...["legacy", "claim"].flatMap((mode) =>
      ["none", "A", "B"].map(
        (contact) => `gmail model replays ${mode} mode, contact ${contact}`,
      ),
    ),
  ],
);
const sent = [...cases.values()].filter((item) => item.delivered !== 0);
console.log(
  `${cases.size} model-generated cases (all 36, ${sent.length} sent) match CONTACT create + MESSAGE send in ${checks.length - 1} groups, and a contact is emailed at its CONTACT email after create and update. Report ${report}`,
);
