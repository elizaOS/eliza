/** Requires the complete maintained real subprocess deadline suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const python = process.env.BENCHMARK_TEST_PYTHON ?? "python3";
const model = "packages/benchmarks/quint/BenchmarkProcessOwner.qnt";
const testFile =
  "packages/benchmarks/orchestrator/tests/test_runner_deadlines.py";
const required = [
  "test_full_profile_has_no_wall_timeout_but_keeps_silent_watchdog",
  "test_normalized_harness_timeouts_reach_every_runtime_environment",
  "test_observed_output_resets_silent_watchdog_and_is_durable",
  "test_silent_full_process_is_stopped_by_progress_watchdog",
  "test_smoke_process_retains_fixed_wall_timeout",
  ...["initial", "poll", "cleanup-refused"].map(
    (stage) =>
      `test_observation_failure_reaps_the_owned_child_before_returning[${stage}]`,
  ),
  "test_cohort_cancellation_stops_three_process_groups_only",
  "test_generic_runner_inserts_row_and_reaches_real_process_boundary",
];
const output = testOutputPath("quint-benchmark-process-owner");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.xml");
const result = spawnSync(
  python,
  [
    "-m",
    "pytest",
    testFile,
    "--import-mode=importlib",
    "-q",
    `--junitxml=${report}`,
  ],
  {
    cwd: root,
    env: { ...process.env, PYTHONPATH: path.join(root, "packages") },
    encoding: "utf8",
  },
);
const log = path.join(directory, "tests.log");
await writeFile(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Conformance terminated by ${result.signal}`);
assert.equal(result.status, 0, `Conformance failed. See ${log}`);
const checked = spawnSync(
  python,
  [
    "-c",
    `
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
suites = list(root)
assert root.tag == "testsuites" and len(suites) == 1
suite = suites[0]
required = json.loads(sys.argv[2])
cases = suite.findall("testcase")
assert int(suite.attrib["tests"]) == len(required) == len(cases)
assert all(int(suite.attrib[key]) == 0 for key in ["failures", "errors", "skipped"])
assert sorted(case.attrib["name"] for case in cases) == sorted(required)
assert all(case.attrib["classname"] == "orchestrator.tests.test_runner_deadlines" for case in cases)
assert all(not list(case) for case in cases)
print(json.dumps({"python": sys.version, "tests": [{"name": case.attrib["name"], "status": "passed"} for case in cases]}))
`,
    report,
    JSON.stringify(required),
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(checked.signal, null, "Conformance report check terminated");
assert.equal(
  checked.status,
  0,
  `Conformance report rejected. ${checked.stderr}`,
);
const observed = JSON.parse(checked.stdout);
const inputs = {};
for (const source of [
  model,
  testFile,
  "packages/benchmarks/orchestrator/runner.py",
  "packages/benchmarks/requirements-ci-constraints.txt",
  "packages/benchmarks/quint/check-process-owner.mjs",
]) {
  inputs[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, inputs, ...observed, report }, null, 2)}\n`,
);
console.log(
  `Conformance passed ${observed.tests.length} required cases. Evidence ${directory}`,
);
