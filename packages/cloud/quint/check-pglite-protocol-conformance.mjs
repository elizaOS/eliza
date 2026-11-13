/** Checks actual socket ownership through both installed module entry points. */
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
  path.join(root, "packages/cloud/quint/pglite_protocol_ownership.qnt"),
);
const scenarios = [
  "retired handler rejects reattachment and fresh handler serves client",
  "extended cycle retains its portal until own Sync",
  "SQL error and ignored owner Query retain cycle until Sync",
  "Sync retains explicit transaction until COMMIT",
  "failed explicit transaction retains owner until ROLLBACK",
  "disconnect before Sync resets backend before peer",
  "disconnect after Execute rolls back orphan write",
  "disconnect during first in-flight BEGIN recovers ownership",
  "shutdown waits for disconnected handler recovery",
  "fragmented same-handler frames preserve order",
  "pg driver runs 100 named and 100 simple queries",
  "closed backend rejects queued and future clients",
];
const expected = ["esm", "cjs"].flatMap((entry) =>
  scenarios.map((name) => `${entry}: ${name}`),
);
const output = testOutputPath("quint-pglite-protocol");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "runner.log");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "packages/cloud/scripts/admin/dev/pglite-socket-protocol.test.ts",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, log);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  `PGlite protocol conformance failed: ${directory}`,
);
assert.equal(result.signal, null);
const counts = (name) => {
  const found = [...log.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))];
  assert.equal(found.length, 1, `Expected one Node test ${name} count`);
  return Number(found[0][1]);
};
const summary = {
  tests: counts("tests"),
  executedTests: counts("pass"),
  failures: counts("fail"),
  cancelled: counts("cancelled"),
  skipped: counts("skipped"),
  todo: counts("todo"),
};
assert.equal(summary.tests, expected.length);
assert.equal(summary.executedTests, expected.length);
assert.equal(
  summary.failures + summary.cancelled + summary.skipped + summary.todo,
  0,
);
const names = [...log.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]);
assert.deepEqual(names.sort(), expected.sort());
writeFileSync(
  path.join(directory, "results.json"),
  `${JSON.stringify({ status: "passed", names, summary }, null, 2)}\n`,
);
console.log(
  `PGlite protocol conformance passed ${expected.length} real-wire tests. Report ${report}`,
);
