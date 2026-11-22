/** Replay generated `/eliza_pair` message sequences through the telegram plugin on PGlite. */
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
  path.join(import.meta.dirname, "TelegramOwnerPairCommand.qnt"),
);
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const EVENTS = 4;
const output = testOutputPath("quint-telegram-owner-pair-command");
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
    // reach all 162 message sequences under this seed (asserted below).
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
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const last = states.at(-1);
  if (last.events.length !== EVENTS) continue;
  const item = {
    verifier: last.verifier,
    events: last.events.map(number),
    relayed: number(last.relayed),
    handled: number(last.handled),
    replies: number(last.replies),
  };
  const key = JSON.stringify([item.verifier, item.events]);
  const seen = cases.get(key);
  if (seen) assert.deepEqual(seen, item, key);
  cases.set(key, item);
}
// With and without OWNER_BIND_VERIFY, four messages of three kinds each.
assert.equal(
  cases.size,
  2 * 3 ** EVENTS,
  "Every message sequence must be replayed",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "__tests__/owner-pair-command.real.test.ts";
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "900000",
    "--",
    process.execPath,
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.real-runtime.config.ts",
    file,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: plugin,
    encoding: "utf8",
    env: { ...process.env, ELIZA_TELEGRAM_OWNER_PAIR_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Telegram owner pairing conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "relays /eliza_pair to OWNER_BIND_VERIFY and shows its usage",
    ...["verifier", "no verifier"].flatMap((config) =>
      ["allowed", "denied", "text"].map(
        (first) => `pair model, ${config}, ${first} first`,
      ),
    ),
  ],
);
const relays = [...cases.values()].reduce(
  (total, item) => total + item.relayed,
  0,
);
console.log(
  `${cases.size} model-generated message sequences (all ${2 * 3 ** EVENTS}) match /eliza_pair on PGlite in ${checks.length - 1} groups, ${relays} codes relayed to OWNER_BIND_VERIFY. Report ${report}`,
);
