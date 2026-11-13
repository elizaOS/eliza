/** Require the existing real SQLite queue tests linked to the model. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(process.argv.length, 3);
assert.equal(
  path.resolve(root, process.argv[2]),
  path.join(root, "packages/host/quint/TraceQueueReceipt.qnt"),
);
const required = [
  "encrypted queue persists events and checkpoints and rejects schemas and wrong keys",
  "only exact durable acknowledgements delete events; flush is serialized and withdrawal survives late replies",
  "queue overflow is explicit and uploads retry without losing an event",
];
const producer = testOutputPath("quint-native-host-trace-queue");
mkdirSync(producer, { recursive: true });
const report = path.join(
  mkdtempSync(path.join(producer, "run-")),
  "trace-queue-tests.tap",
);
const result = spawnSync(
  "bun",
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "45000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=^(?:${required.map(RegExp.escape).join("|")})$`,
    "packages/host/native-host/trace-queue.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, output);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Trace queue checks interrupted. ${report}`);
assert.equal(result.status, 0, `Trace queue checks failed. ${report}`);
const names = [...output.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
);
assert.deepEqual(
  names.sort(),
  required.sort(),
  `Trace queue tests changed. ${report}`,
);
const counts = new Set(output.split(/\r?\n/));
for (const line of [
  `# tests ${required.length}`,
  `# pass ${required.length}`,
  "# fail 0",
  "# skipped 0",
  "# cancelled 0",
]) {
  assert(counts.has(line), `Incomplete trace queue checks. ${report}`);
}
console.log(
  `Trace queue conformance passed ${required.length} real SQLite cases. ${report}`,
);
