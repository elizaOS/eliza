/** Replay generated tool and argument cases through the cloud planner's tool-call boundary. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const cloud = path.join(root, "packages/cloud/shared");
const model = path.resolve(process.argv[2] ?? "");
assert.equal(model, path.join(import.meta.dirname, "McpArgumentShape.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8")).cases;
const TRACES = 1000;
const CASES = 10;
const output = testOutputPath("quint-mcp-argument-shape");
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
    "--seed=20261117",
    `--max-samples=${modelCase.samples}`,
    // 1000 traces already return for all ten cases under this seed
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
const cases = new Map();
for (const file of readdirSync(directory)) {
  const states = JSON.parse(readFileSync(path.join(directory, file), "utf8")).states;
  const last = states.at(-1);
  if (!last.done) continue;
  const item = {
    tool: last.tool,
    shape: last.shape,
    serverAccepts: last.accepts,
    admitted: last.admitted,
    delivered: last.delivered,
  };
  assert.equal(last.dispatched, last.admitted, file);
  const key = `${item.tool}/${item.shape}`;
  const seen = cases.get(key);
  if (seen) assert.deepEqual(seen, item, key);
  cases.set(key, item);
}
assert.equal(cases.size, CASES, "Every tool and argument shape must be replayed");
const input = path.join(directory, "cases.json");
writeFileSync(input, JSON.stringify([...cases.keys()].sort().map((key) => cases.get(key))));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "src/lib/eliza/plugin-mcp/actions/dynamic-tool-nested-arguments.test.ts";
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
    path.join(root, "packages/scripts/vitest/default.config.ts"),
    file,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: cloud,
    encoding: "utf8",
    env: { ...process.env, ELIZA_MCP_ARGUMENT_SHAPE_MODEL_CASES: input },
  }
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `MCP argument shape conformance failed. See ${log}`);
const suite = "MCP nested tool arguments at the planner boundary";
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(cloud, file),
  [
    `${suite} sends server-github push_files a file list`,
    `${suite} refuses a file without content before dispatch`,
    `${suite} sends a word to a property without a type`,
    ...["push_files", "create_page", "sum_ids", "echo_value", "set_labels"].map(
      (tool) => `${suite} argument model replays ${tool}`
    ),
  ]
);
const delivered = [...cases.values()].filter((item) => item.delivered).length;
console.log(
  `${cases.size} model-generated tool and argument cases (${delivered} delivered) match executePlannedToolCall and a real MCP SDK server in ${checks.length - 3} groups. Report ${report}`
);
