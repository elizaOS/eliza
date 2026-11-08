/** Requires the complete named real implementation conformance suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const testFile = "packages/agent/test/agent-lifecycle-stop-start.test.ts";
const model = "packages/agent/quint/api-lifecycle.qnt";
const requiredTests = [
  "boots a new runtime after a successful stop",
  "boots a new runtime after teardown reports a failure",
  "rejects pause and resume without a live runtime or during boot and teardown over HTTP",
  "owns HTTP teardown before a disposer re-enters close",
];
const output = testOutputPath("quint-agent-lifecycle");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const resultPath = path.join(directory, "tests.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "packages/agent/vitest.config.ts",
    testFile,
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${resultPath}`,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.signal, null, `Conformance terminated by ${result.signal}`);
assert.equal(
  result.status,
  0,
  `Conformance failed. See ${directory}/tests.log`,
);
const tests = requireVitestConformance(
  JSON.parse(await readFile(resultPath, "utf8")),
  path.join(root, testFile),
  requiredTests,
);
const inputs: Record<string, string> = {};
for (const source of [
  model,
  testFile,
  "packages/scripts/lib/vitest-conformance.ts",
]) {
  inputs[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, inputs, tests, report: resultPath }, null, 2)}\n`,
);
console.log(
  `Conformance passed ${tests.length} required cases. Evidence ${directory}`,
);
