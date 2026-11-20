/** Replay generated post sequences through the autonomous post step. */
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
assert.equal(model, path.join(import.meta.dirname, "XDuplicatePost.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const TRACES = 3000;
const POSTS = ["gm", "gmFrens", "paradigm", "shiftParadigm", "wagmi", "sun"];
const SEQUENCES = POSTS.length ** 3;
const output = testOutputPath("quint-x-duplicate-post");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const traces = path.join(directory, "traces");
mkdirSync(traces);
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
    "--seed=20261117",
    `--max-samples=${modelCase.samples}`,
    // 3000 traces already write all 216 sequences under this seed
    // (asserted below).
    `--n-traces=${TRACES}`,
    `--max-steps=${modelCase.maxSteps}`,
    "--invariants",
    ...modelCase.invariants,
    `--out-itf=${path.join(traces, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" },
);
const cases = new Map();
for (const file of readdirSync(traces)) {
  const states = JSON.parse(
    readFileSync(path.join(traces, file), "utf8"),
  ).states;
  const last = states.at(-1);
  if (last.generated.length !== 3) continue;
  const item = { generated: last.generated, sent: last.sent };
  const key = item.generated.join(",");
  const seen = cases.get(key);
  if (seen) assert.deepEqual(seen, item, key);
  cases.set(key, item);
}
assert.equal(cases.size, SEQUENCES, "Every post sequence must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "src/duplicate-post-words.test.ts";
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
    env: { ...process.env, ELIZA_X_DUPLICATE_POST_MODEL_CASES: input },
  },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `X duplicate post conformance failed. See ${log}`,
);
const suite = "duplicate posts are matched on whole words";
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    `${suite} posts paradigm and wagmi after a GM post`,
    `${suite} skips a post that contains a recent post`,
    ...POSTS.map((name) => `${suite} post model replays ${name} first`),
  ],
);
const skipped = [...cases.values()].filter(
  (item) => item.sent.length < item.generated.length,
).length;
console.log(
  `${cases.size} model-generated post sequences (${skipped} with a skipped repeat) match the autonomous post step over HTTPS in ${checks.length - 2} groups, and the two named cases pass. Report ${report}`,
);
