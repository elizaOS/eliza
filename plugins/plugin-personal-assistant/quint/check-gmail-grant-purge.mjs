/** Replay generated Google account purges through the Gmail cleanup of disconnect and account handoff. */
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
assert.equal(model, path.join(import.meta.dirname, "GmailGrantPurge.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-gmail-grant-purge");
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
// Quint maps are serialized as [key, value] pairs.
const byGrant = (value) => {
  const rows = [];
  for (const [key, item] of value["#map"])
    rows[number(key)] = { mail: item.mail, cursor: item.cursor };
  return rows;
};
const sequences = new Map();
const firstPurges = new Set();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const start = byGrant(states[0].rows);
  const steps = [];
  let previous = states[0];
  for (const state of states.slice(1)) {
    const rows = byGrant(state.rows);
    if (number(state.applied) !== number(previous.applied)) {
      steps.push({ purge: number(state.last), rows });
    } else {
      // Asking, reconnecting and stuttering change no local row. A sync
      // that changes one imports that account's mail and cursor.
      const before = byGrant(previous.rows);
      const synced = rows.findIndex(
        (item, grant) =>
          item.mail !== before[grant].mail ||
          item.cursor !== before[grant].cursor,
      );
      if (synced >= 0) steps.push({ sync: synced, rows });
    }
    previous = state;
  }
  const first = steps.find((item) => item.purge !== undefined);
  if (!first) continue;
  firstPurges.add(JSON.stringify({ start, purge: first.purge }));
  const item = { start, steps };
  sequences.set(JSON.stringify(item), item);
}
// 27 saved states of the three accounts, each followed by one of 4 purges.
assert.equal(
  firstPurges.size,
  108,
  "Every saved state and first purge must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file =
  "plugins/plugin-personal-assistant/src/lifeops/gmail-grant-purge-model.integration.test.ts";
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "900000",
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
    env: { ...process.env, ELIZA_GMAIL_GRANT_PURGE_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Gmail grant purge conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, file),
  [
    "disconnecting the previous account",
    "disconnecting the replacement account",
    "disconnecting the agent account",
    "the handoff removing old imports",
  ].map(
    (name) =>
      `gmail grant purge model replays the gmail grant purge model when the first purge is ${name}`,
  ),
);
console.log(
  `${sequences.size} model-generated purge sequences (all 108 saved states and first purges) match the Gmail cleanup of disconnect and account handoff in ${checks.length} groups. Report ${report}`,
);
