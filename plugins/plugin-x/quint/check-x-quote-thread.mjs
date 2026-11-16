/** Replay generated quote lengths through the timeline quote action. */
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
assert.equal(model, path.join(import.meta.dirname, "XQuoteThread.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 1000;
const LENGTHS = 10;
const output = testOutputPath("quint-x-quote-thread");
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
    // 1000 traces already finish a thread for all ten lengths under this
    // seed (asserted below).
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
  if (number(last.remaining) !== 0 && !last.refused) continue;
  const item = {
    length: number(last.quoteLength),
    posts: last.posts.map(number),
    refused: last.refused,
  };
  const seen = cases.get(item.length);
  if (seen) assert.deepEqual(seen, item, String(item.length));
  cases.set(item.length, item);
}
assert.equal(cases.size, LENGTHS, "Every quote length must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify(
    [...cases.keys()].sort((a, b) => a - b).map((key) => cases.get(key)),
  ),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "src/quote-thread-link.test.ts";
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
    env: { ...process.env, ELIZA_X_QUOTE_THREAD_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `X quote thread conformance failed. See ${log}`);
const suite = "timeline quote threads keep room for the quoted post's link";
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    `${suite} posts a 269-character quote that X accepts`,
    `${suite} quote thread model replays one post`,
    `${suite} quote thread model replays 257 to 280 characters`,
    `${suite} quote thread model replays longer quotes`,
  ],
);
const threads = [...cases.values()].filter(
  (item) => item.posts.length > 1,
).length;
console.log(
  `${cases.size} model-generated quote lengths (${threads} as threads) match the timeline quote action over HTTPS in ${checks.length - 1} groups, and a 269-character sentence is posted. Report ${report}`,
);
