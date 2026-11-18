/** Replay generated proxied requests through the scheduling and calendar routes. */
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

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2] ?? "");
assert.equal(
  model,
  path.join(import.meta.dirname, "ForwardedProtoRouteBase.qnt"),
);
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
  readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-forwarded-proto");
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
const sequences = new Map();
const singleRequests = new Set();
for (const file of readdirSync(directory)) {
  if (!file.endsWith(".itf.json")) continue;
  const states = JSON.parse(
    readFileSync(path.join(directory, file), "utf8"),
  ).states;
  const route = number(states[0].route);
  const headers = [];
  // A request is served where its status moves from waiting to served.
  for (const [index, state] of states.entries()) {
    const status = number(state.status);
    assert.notEqual(status, 2, `${file} reached a failure`);
    if (index > 0 && status === 1 && number(states[index - 1].status) === 0) {
      headers.push(number(state.header));
    }
  }
  if (headers.length === 0) continue;
  singleRequests.add(`${route}:${headers[0]}`);
  sequences.set(JSON.stringify({ route, headers }), { route, headers });
}
// Two routes, each with five X-Forwarded-Proto shapes.
assert.equal(
  singleRequests.size,
  10,
  "Every route and header case must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
  input,
  JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const suites = [
  {
    name: "scheduling",
    cwd: path.join(root, "plugins/plugin-scheduling"),
    file: "src/routes/plugin-routes.forwarded-proto.test.ts",
    test: "scheduled-tasks route behind proxies replays the forwarded proto model through the scheduled-task route",
    filter:
      "replays the forwarded proto model through the scheduled-task route",
  },
  {
    name: "calendar",
    cwd: path.join(root, "plugins/plugin-calendar"),
    file: "test/google-calendar-watch.pglite.test.ts",
    test: "Google Calendar push lifecycle replays the forwarded proto model through the Google Calendar webhook",
    filter:
      "replays the forwarded proto model through the Google Calendar webhook",
  },
];
for (const suite of suites) {
  const report = path.join(directory, `vitest-${suite.name}.json`);
  const log = path.join(directory, `vitest-${suite.name}.log`);
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "300000",
      "--",
      process.execPath,
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      suite.file,
      "-t",
      suite.filter,
      "--cache=false",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: suite.cwd,
      encoding: "utf8",
      env: { ...process.env, ELIZA_FORWARDED_PROTO_MODEL_CASES: input },
    },
  );
  writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
  if (child.error) throw child.error;
  assert.equal(
    child.status,
    0,
    `Forwarded proto conformance failed in ${suite.name}. See ${log}`,
  );
  const summary = JSON.parse(readFileSync(report, "utf8"));
  const passed = summary.testResults
    .flatMap((result) => result.assertionResults)
    .filter((result) => result.status === "passed")
    .map((result) => result.fullName);
  assert.deepEqual(passed, [suite.test], `${suite.name} replay did not pass`);
  assert.equal(summary.numFailedTests, 0);
}
console.log(
  `${sequences.size} model-generated request sequences (all 10 route and header cases) match the scheduling and calendar routes over real HTTP`,
);
