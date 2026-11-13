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
      "host replacement drains a detached adapter query outside the dirty snapshot",
      "shared adapter handoff transfers the live scheduler and drains its old query before replacement close",
      "shared adapter handoff preserves an active replacement scheduler and its future work",
      "chained shared adapter handoffs drain failed old queries and preserve an unrelated scheduler",
      "identical adapter handoff preserves the active scheduler registration and future work",
      "published replacement stop retains the outgoing shared retention callback",
      "fast replacement close retains a failed callback through an identical adapter handle",
      "chained published replacements retain the original shared callback before final close",
    ]
  : [
      "boots a new runtime after a successful stop",
      "boots a new runtime after teardown reports a failure",
      "rejects competing lifecycle and wallet reloads during HTTP boot and teardown",
      "owns HTTP teardown before a disposer re-enters close",
      "retains paused ownership after failed builds and drains admitted work before HTTP replacement",
    ];
const suites = [
  { file: testFile, required: requiredTests },
  ...(retirement
    ? [
        {
          file: "packages/agent/src/runtime/restore-generation.boot.test.ts",
          required: [
            "does not boot or promote an unfinished generation and rejects a missing physical database",
            "retains restore authority across server restarts without self-registering routes",
            "initializes and restarts the real runtime on the committed database without losing later writes",
            "rejects conflicting identity, config and replaced directories before runtime construction",
          ],
        },
      ]
    : []),
];
const output = testOutputPath(
  retirement ? "quint-agent-adapter-retirement" : "quint-agent-lifecycle",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const tests: Array<{ name: string; status: string }> = [];
const reports: Array<{ file: string; report: string }> = [];
for (const [index, suite] of suites.entries()) {
  const resultPath = path.join(directory, `${index}-tests.json`);
  const logPath = path.join(directory, `${index}-tests.log`);
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=eliza-source",
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "packages/agent/vitest.config.ts",
      suite.file,
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
  await writeFile(logPath, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  assert.equal(
    result.signal,
    null,
    `Conformance terminated by ${result.signal}`,
  );
  assert.equal(result.status, 0, `Conformance failed. See ${logPath}`);
  tests.push(
    ...requireVitestConformance(
      JSON.parse(await readFile(resultPath, "utf8")),
      path.join(root, suite.file),
      suite.required,
    ),
  );
  reports.push({ file: suite.file, report: resultPath });
}
const inputs: Record<string, string> = {};
for (const source of [
  model,
  ...suites.map((suite) => suite.file),
  ...(retirement
    ? [
        "packages/agent/src/runtime/eliza.ts",
        "packages/agent/src/api/server.ts",
        "packages/agent/src/api/agent-admin-routes.ts",
        "packages/agent/src/api/runtime-replacement-ownership.ts",
        "packages/agent/src/runtime/eliza-plugin.ts",
        "packages/agent/src/runtime/memory-retention-service.ts",
        "packages/agent/src/runtime/retention-task.ts",
        "packages/core/src/runtime.ts",
        "packages/core/src/runtime/retirement.ts",
        "packages/core/src/runtime/service-lifecycle.ts",
        "packages/core/src/services/task.ts",
        "packages/core/src/services/task-scheduler.ts",
        "packages/core/src/runtime/room-handler-queue.ts",
        "packages/agent/src/api/agent-lifecycle-routes.ts",
        "packages/agent/src/api/agent-admin-routes.ts",
        "packages/agent/src/services/agent-backup-restore-v3-runtime-generation.ts",
      ]
    : [
        "packages/agent/src/api/agent-lifecycle-routes.ts",
        "packages/agent/src/api/agent-admin-routes.ts",
        "packages/agent/src/api/runtime-replacement-ownership.ts",
        "packages/agent/src/api/server.ts",
        "packages/core/src/runtime/room-handler-queue.ts",
        "plugins/plugin-wallet/src/api/wallet-routes.ts",
        "packages/agent/src/config/feature-flags.ts",
      ]),
  "packages/scripts/lib/vitest-conformance.ts",
]) {
  inputs[source] = createHash("sha256")
    .update(await readFile(path.join(root, source)))
    .digest("hex");
}
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, inputs, tests, reports }, null, 2)}\n`,
);
console.log(
  `Conformance passed ${tests.length} required cases. Evidence ${directory}`,
);
