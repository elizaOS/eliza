/** Replay generated task board event sequences through `/tasks` on PGlite. */
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
  path.join(import.meta.dirname, "TelegramTaskBoardStore.qnt"),
);
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const EVENTS = 4;
const output = testOutputPath("quint-telegram-task-board-store");
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
    // reach all 34 event sequences under this seed (asserted below).
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
    events: last.events.map(number),
    calls: last.calls,
    visible: last.visible["#set"].map(number).sort((a, b) => a - b),
    stored: number(last.stored),
    pinned: number(last.pinned),
    posts: number(last.posts),
    edits: number(last.edits),
  };
  const key = JSON.stringify(item.events);
  const seen = cases.get(key);
  if (seen) assert.deepEqual(seen, item, key);
  cases.set(key, item);
}
// Four events, each `/tasks`, a restart, or a delete while a board is shown.
assert.equal(cases.size, 34, "Every event sequence must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "__tests__/task-board-store.real.test.ts";
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
    env: { ...process.env, ELIZA_TELEGRAM_TASK_BOARD_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Telegram task board conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    "edits one pinned task board after status changes and a restart",
    "task board model replays tasks first",
    "task board model replays restart first",
  ],
);
const restarts = [...cases.values()].filter((item) =>
  item.events.includes(2),
).length;
console.log(
  `${cases.size} model-generated event sequences (all 34, ${restarts} with a restart) match /tasks on PGlite in ${checks.length - 1} groups, and one pinned board is edited after status changes and a restart. Report ${report}`,
);
