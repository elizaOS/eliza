/** Runs the owned HTTP recovery and trigger execution exclusion scenarios. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = process.argv[2];
assert(model, "The shared checker must provide the model path");
assert.equal(path.basename(model), "TriggerRecovery.qnt");
const testFile = "packages/agent/test/automations-owner-principal-http.test.ts";
const output = testOutputPath("quint-trigger-recovery");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const resultPath = path.join(directory, "tests.json");
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-vitest.ts",
    "run",
    "--config",
    "packages/agent/vitest.config.ts",
    testFile,
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
assert.equal(
  result.signal,
  null,
  `Integration tests terminated by ${result.signal}`,
);
assert.equal(
  result.status,
  0,
  `Trigger recovery HTTP integration failed. See ${directory}/tests.log`,
);
const requiredTests = [
  "rejects a distinct registered OWNER before Node trigger/feed handlers can use local records",
  "keeps a persisted legacy heartbeat without entity ownership read-only",
  "rejects stale presented credentials instead of promoting loopback access",
  "lists an automation conversation from the world of an earlier name",
  "renders persisted owner work and admitted automations without promoting maintenance queues into tasks",
  "keeps workflow todo responses and host overview projections identical",
  "archives and restores the same owned prompt without losing its definition",
  "refuses removal while the same trigger is executing",
  "rejects stale recovery snapshots even when the clock does not advance",
];
const tests = requireVitestConformance(
  JSON.parse(await readFile(resultPath, "utf8")),
  path.join(root, testFile),
  requiredTests,
);
const inputs = [
  model,
  testFile,
  "packages/scripts/lib/vitest-conformance.ts",
  "packages/agent/src/triggers/activity.ts",
  "packages/agent/src/triggers/runtime.ts",
  "plugins/plugin-workflow/src/trigger-routes.ts",
];
const hashes = {};
for (const input of inputs) {
  hashes[input] = createHash("sha256")
    .update(await readFile(path.resolve(root, input)))
    .digest("hex");
}
const evidence = {
  model,
  inputs: hashes,
  tests,
  report: resultPath,
  limitations:
    "Scenario conformance through the real Node HTTP owner boundary and stored task adapter. This does not prove arbitrary multi-process writer interleavings.",
};
await writeFile(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
  `Trigger recovery scenario conformance passed ${tests.length} HTTP tests.`,
);
console.log(`Evidence: ${path.join(directory, "evidence.json")}`);
