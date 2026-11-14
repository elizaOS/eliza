/** Requires the complete named real implementation conformance suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const testFile = "packages/agent/src/api/hono-adapter.test.ts";
const model = "packages/agent/quint/api-http-body.qnt";
const requiredTests = [
  "drains a rejected chunked body before reusing its connection",
  "drops a handler body for HTTP status 204",
  "drops a handler body for HTTP status 205",
  "drops a handler body for HTTP status 304",
  "keeps trusted contexts complete and isolated despite forged headers and overlapping requests",
  "cancels a streaming producer when its HTTP client disconnects",
  "propagates native cancellation through the registered HTTP kernel",
  "rejects a partial producer failure over HTTP and native dispatch",
  "cancels Android buffered dispatch and refuses a pre-aborted request",
  "serves the consolidated assistant routes through authenticated HTTP",
  "updates HTTP paths, methods and authorization when route contributions change",
];
const output = testOutputPath("quint-agent-http-body");
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
const schedulingFile =
  "plugins/plugin-scheduling/src/routes/scheduled-tasks.seam.test.ts";
const schedulingReport = path.join(directory, "scheduling.json");
const schedulingResult = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.ts",
    "src/routes/scheduled-tasks.seam.test.ts",
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${schedulingReport}`,
  ],
  {
    cwd: path.join(root, "plugins/plugin-scheduling"),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
await writeFile(
  path.join(directory, "scheduling.log"),
  `${schedulingResult.stdout ?? ""}\n${schedulingResult.stderr ?? ""}`,
);
if (schedulingResult.error) throw schedulingResult.error;
assert.equal(
  schedulingResult.signal,
  null,
  "Scheduling conformance was interrupted",
);
assert.equal(
  schedulingResult.status,
  0,
  `Scheduling conformance failed. See ${directory}/scheduling.log`,
);
const schedulingTests = requireVitestConformance(
  JSON.parse(await readFile(schedulingReport, "utf8")),
  path.join(root, schedulingFile),
  [
    "scheduled-tasks REST seam (real reader, real service, real routes) schedules a task through the real reader",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects an explicit {} edit body with 400 and writes no edited log row (#23977)",
    "scheduled-tasks REST seam (real reader, real service, real routes) applies a real edit and records exactly one edited row with the edited keys",
    "scheduled-tasks REST seam (real reader, real service, real routes) reads a chunked edit body without content-length (#23930 through the seam)",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects an empty chunked edit body with the reader's 400 parse error",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects malformed JSON with the reader's 400",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects a JSON null body with the reader's non-object 400",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects an over-1MiB edit body with the reader's 413",
    "scheduled-tasks REST seam (real reader, real service, real routes) honors a chunked test-probe body without content-length (#23977)",
    "scheduled-tasks REST seam (real reader, real service, real routes) defaults the test-probe to a reminder when no body framing is present",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects a cron trigger zone the scheduler cannot resolve with 400",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects an unparseable cron expression with 400",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects a cron expression whose date never occurs with 400",
    "scheduled-tasks REST seam (real reader, real service, real routes) accepts a cron expression for a leap day or an either-day schedule",
    "scheduled-tasks REST seam (real reader, real service, real routes) rejects an edit to an unresolvable cron trigger zone with 400",
    "scheduled-tasks REST seam (real reader, real service, real routes) keeps a stored cron task with an unresolvable zone editable and importable",
    "scheduled-tasks REST seam (real reader, real service, real routes) accepts a cron trigger with an IANA zone or owner_local",
    "scheduled-tasks REST seam (real reader, real service, real routes) persists an unframed IPC string edit through the real schedule route",
    "scheduled-tasks REST seam (real reader, real service, real routes) persists an unframed IPC object edit through the real schedule route",
    "scheduled-tasks REST seam (real reader, real service, real routes) persists an unframed IPC buffer edit through the real schedule route",
    "scheduled-tasks REST seam (real reader, real service, real routes) preserves explicit chunked framing on an IPC schedule edit",
    "scheduled-tasks REST seam (real reader, real service, real routes) preserves explicit zero framing on an IPC schedule edit",
  ],
);
const inputs: Record<string, string> = {};
for (const source of [
  model,
  testFile,
  "packages/scripts/lib/vitest-conformance.ts",
  schedulingFile,
  "packages/agent/src/api/dispatch-route.ts",
  "packages/agent/src/api/in-process-api.ts",
  "plugins/plugin-scheduling/src/routes/scheduled-tasks.ts",
  "packages/host/src/api/http-helpers.ts",
]) {
  inputs[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, inputs, tests, schedulingTests, report: resultPath, schedulingReport }, null, 2)}\n`,
);
console.log(
  `Conformance passed ${tests.length} required cases. Evidence ${directory}`,
);
