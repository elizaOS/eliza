/** Replay generated provider and argument cases through the MCP call_tool action. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const plugin = path.resolve(import.meta.dirname, "..");
const model = path.resolve(process.argv[2] ?? "");
assert.equal(model, path.join(import.meta.dirname, "McpArgumentCompatibility.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8")).cases;
const TRACES = 1000;
const CASES = 9;
const output = testOutputPath("quint-mcp-argument-compatibility");
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
    // 1000 traces already return for all nine cases under this seed
    // (asserted below).
    `--n-traces=${TRACES}`,
    `--max-steps=${modelCase.maxSteps}`,
    "--invariants",
    ...modelCase.invariants,
    `--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { stdio: "inherit" }
);
const number = (value) => Number(value["#bigint"]);
const members = (value) => [...value["#set"]].sort();
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(readFileSync(path.join(directory, file), "utf8")).states;
  const last = states.at(-1);
  if (!last.done) continue;
  assert.deepEqual(members(last.restated), members(last.hidden), file);
  const item = {
    provider: last.provider,
    arguments: last.shape,
    attempts: number(last.attempts),
    sent: last.sent,
    hidden: members(last.hidden),
  };
  const key = `${item.provider}/${item.arguments}`;
  const seen = cases.get(key);
  if (seen) assert.deepEqual(seen, item, key);
  cases.set(key, item);
}
assert.equal(cases.size, CASES, "Every provider and argument shape must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(input, JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "__tests__/tool-compatibility-argument-validation.test.ts";
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
    env: { ...process.env, ELIZA_MCP_ARGUMENT_COMPATIBILITY_MODEL_CASES: input },
  }
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `MCP argument compatibility conformance failed. See ${log}`);
const suite = "MCP arguments keep the server schema under provider rewrites";
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, file),
  [
    `${suite} refuses a one-item pair under the google rewrite`,
    `${suite} argument model replays no rewrite`,
    `${suite} argument model replays the anthropic rewrite`,
    `${suite} argument model replays the google rewrite`,
  ]
);
const sent = [...cases.values()].filter((item) => item.sent).length;
console.log(
  `${cases.size} model-generated provider and argument cases (${sent} sent) match the MCP call_tool action on a real stdio server in ${checks.length - 1} groups, and the google rewrite still refuses a one-item pair. Report ${report}`
);
