/** Requires all real child-process cases for the Agent signal drain. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/agent/quint/process-signal-drain.qnt";
const testFile = "packages/agent/test/process-lifecycle-exit.test.ts";
const required = [
  "drains cleanup and reports shutdown status ()",
  "drains cleanup and reports shutdown status (teardown)",
  "drains cleanup and reports shutdown status (reporter)",
  ...["Bun", "Node"].flatMap((host) => [
    `drains ${host} cleanup after SIGTERM then SIGTERM ()`,
    `drains ${host} cleanup after SIGINT then SIGINT (reporter)`,
    `drains ${host} cleanup after SIGTERM then SIGINT ()`,
    `distinguishes ${host} SIGKILL from completed cleanup`,
  ]),
];
const output = testOutputPath("quint-agent-signal-drain");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.json");
const log = path.join(directory, "tests.log");
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
    `--outputFile=${report}`,
  ],
  { cwd: root, encoding: "utf8" },
);
await writeFile(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Conformance terminated by ${result.signal}`);
assert.equal(result.status, 0, `Conformance failed. See ${log}`);
const tests = requireVitestConformance(
  JSON.parse(await readFile(report, "utf8")),
  path.join(root, testFile),
  required,
);
const inputs: Record<string, string> = {};
for (const source of [
  model,
  testFile,
  "packages/agent/src/runtime/process-lifecycle.ts",
  "packages/agent/src/runtime/eliza.ts",
  "packages/agent/test/fixtures/process-lifecycle-child.ts",
  "packages/scripts/lib/vitest-conformance.ts",
]) {
  inputs[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, inputs, tests, report }, null, 2)}\n`,
);
console.log(
  `Conformance passed ${tests.length} required cases. Evidence ${directory}`,
);
