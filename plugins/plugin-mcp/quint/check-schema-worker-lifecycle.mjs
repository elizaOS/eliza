import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = path.join(root, "plugins/plugin-mcp");
const testFile = "__tests__/schema-worker-lifecycle.test.ts";
const required = [
  ...["implicit", "draft07", "current"].map(
    (dialect) =>
      `MCP isolated schema worker lifecycle validates ${dialect} dialect under the request deadline`
  ),
  "MCP isolated schema worker lifecycle isolates identical schema ids in successive workers",
  "MCP isolated schema worker lifecycle retains the request deadline for expensive untrusted validation",
];
const output = testOutputPath("quint-mcp-schema-worker");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "result.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    testFile,
    "--maxWorkers=1",
    "--no-file-parallelism",
    `--fsModuleCachePath=${path.join(directory, "cache")}`,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: plugin, encoding: "utf8", timeout: 120_000 }
);
const log = path.join(directory, "tests.log");
await writeFile(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.signal, null, `Worker conformance interrupted; see ${log}`);
assert.equal(child.status, 0, `Worker conformance failed; see ${log}`);
const result = JSON.parse(await readFile(report, "utf8"));
const tests = result.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(result.success, true);
assert.equal(tests.length, required.length);
assert.equal(result.numFailedTests, 0);
assert.equal(result.numPendingTests, 0);
assert.deepEqual(tests.map((test) => test.fullName).sort(), required.sort());
assert(tests.every((test) => test.status === "passed"));
const inputs = {};
for (const file of [
  "plugins/plugin-mcp/src/utils/validation.ts",
  `plugins/plugin-mcp/${testFile}`,
  "plugins/plugin-mcp/quint/SchemaWorkerLifecycle.qnt",
  "plugins/plugin-mcp/quint/check-schema-worker-lifecycle.mjs",
])
  inputs[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ node: process.version, inputs, tests }, null, 2)}\n`
);
console.log(
  `MCP worker conformance passed ${tests.length} real-worker cases; evidence ${directory}`
);
