/** Requires the complete named real implementation conformance suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const retirement =
  process.argv[2] !== undefined &&
  path.resolve(root, process.argv[2]) ===
    path.join(root, "packages/agent/quint/runtime-lifecycle.qnt");
const testFile = retirement
  ? "packages/agent/test/hot-reload-shared-database.test.ts"
  : "packages/agent/test/agent-lifecycle-stop-start.test.ts";
const model = retirement
  ? "packages/agent/quint/runtime-lifecycle.qnt"
  : "packages/agent/quint/api-lifecycle.qnt";
const requiredTests = retirement
  ? [
      "keeps the shared connection open for the replacement and closes it on the replacement's shutdown",
      "closes the replaced runtime's database when the replacement uses another one",
      "drains the real retention callback before HTTP replacement closes its SQLite adapter",
      "reports a real SQLite callback failure after retirement without closing replacement storage",
    ]
  : [
      "boots a new runtime after a successful stop",
      "boots a new runtime after teardown reports a failure",
      "rejects pause and resume without a live runtime or during boot and teardown over HTTP",
      "owns HTTP teardown before a disposer re-enters close",
      "retains paused ownership after failed builds and drains admitted work before HTTP replacement",
    ];
const output = testOutputPath(
  retirement ? "quint-agent-adapter-retirement" : "quint-agent-lifecycle",
);
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
  ...(retirement
    ? [
        "packages/agent/src/runtime/eliza.ts",
        "packages/agent/src/runtime/eliza-plugin.ts",
        "packages/agent/src/runtime/memory-retention-service.ts",
        "packages/agent/src/runtime/retention-task.ts",
        "packages/core/src/runtime.ts",
        "packages/core/src/runtime/retirement.ts",
        "packages/core/src/runtime/service-lifecycle.ts",
        "packages/core/src/services/task.ts",
      ]
    : [
        "packages/agent/src/api/agent-lifecycle-routes.ts",
        "packages/agent/src/api/agent-admin-routes.ts",
        "packages/agent/src/api/runtime-replacement-ownership.ts",
        "packages/agent/src/api/server.ts",
        "packages/core/src/runtime/room-handler-queue.ts",
      ]),
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
