/** Runs the real owned-process regression and fail-closed inspection cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const python = process.env.BENCHMARK_TEST_PYTHON ?? "python3";
const model = "packages/benchmarks/quint/AcceptanceGroupSignal.qnt";
const testFile = "packages/benchmarks/tests/test_acceptance_process_groups.py";
const required = [
  "test_darwin_zombie_only_descendant_does_not_abort_cleanup",
  ...["live", "failed", "timeout", "malformed", "empty"].map(
    (kind) =>
      `test_denied_signal_requires_confirmed_absence_of_live_members[${kind}]`,
  ),
];
const output = testOutputPath("quint-acceptance-group-signal");
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
import json, os, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
suites = list(root)
assert root.tag == "testsuites" and len(suites) == 1
suite = suites[0]
required = json.loads(sys.argv[2])
cases = suite.findall("testcase")
assert int(suite.attrib["tests"]) == len(required) == len(cases)
assert all(int(suite.attrib[key]) == 0 for key in ["failures", "errors"])
assert sorted(case.attrib["name"] for case in cases) == sorted(required)
for case in cases:
    assert case.attrib["classname"] == "tests.test_acceptance_process_groups"
    expected_skip = os.name != "posix" or (sys.platform != "darwin" and case.attrib["name"] == required[0])
    assert bool(case.find("skipped") is not None) == expected_skip
    assert all(child.tag == "skipped" for child in case)
print(json.dumps({"python": sys.version, "platform": sys.platform, "tests": [{"name": c.attrib["name"], "status": "skipped" if c.find("skipped") is not None else "passed"} for c in cases]}))
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
  "packages/benchmarks/scripts/acceptance_gate.py",
  "packages/benchmarks/quint/check-acceptance-group-signal.mjs",
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
  `Conformance checked ${observed.tests.length} required cases. Evidence ${directory}`,
);
