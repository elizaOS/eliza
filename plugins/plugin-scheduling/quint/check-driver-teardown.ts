/** Requires the named real AgentRuntime and SQLite driver lifecycle cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "plugins/plugin-scheduling/quint/ScheduledDriverTeardown.qnt";
const packageRoot = path.join(root, "plugins/plugin-scheduling");
const testFile = "src/scheduled-task/record-startup.test.ts";
const required = [
  "selects durable record storage during actual runtime service startup",
  "drains a held driver insert with received acknowledgement and reloads one fresh row",
  "drains a held driver insert with lost acknowledgement and reloads one fresh row",
  "refuses a deferred boot from the old worker after reload",
  "seeds the opt-in consumer routines disabled, alongside the fallback, once",
];
const output = testOutputPath("quint-scheduling-driver-teardown");
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
    "vitest.config.ts",
    testFile,
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: packageRoot, encoding: "utf8" },
);
await writeFile(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Conformance terminated by ${result.signal}`);
assert.equal(result.status, 0, `Conformance failed. See ${log}`);
const tests = requireVitestConformance(
  JSON.parse(await readFile(report, "utf8")),
  path.join(packageRoot, testFile),
  required,
);
const inputs: Record<string, string> = {};
for (const source of [
  model,
  `plugins/plugin-scheduling/${testFile}`,
  "plugins/plugin-scheduling/src/plugin.ts",
  "plugins/plugin-scheduling/src/scheduled-task/standalone-tick.ts",
  "packages/core/src/plugin-lifecycle.ts",
  "plugins/plugin-sqlite/adapter.ts",
  "plugins/plugin-sqlite/records.ts",
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
