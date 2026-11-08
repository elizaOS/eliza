/** Exercise the real native storage lease and receipt SQL against PGlite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "NativeStoragePutRecovery.qnt"),
  "Native storage conformance requires its own model path",
);
const suite =
  "packages/cloud/shared/src/db/repositories/__tests__/org-storage-mutations.pglite.test.ts";
const required = [
  "does not reconcile a fresh reserved operation while its request is active",
  "fences a stale reconciler against a concurrent live provider claim",
  "requires an expired provider-absence quarantine before one reconciler can recheck",
  "atomically fences credit reservation against prepared-operation recovery",
  "atomically settles the exact tenant hold before publishing the object",
  "atomically releases quota and writes a terminal receipt on insufficient credit",
  "atomically refunds an orphan hold with quota and terminal replay",
];
const output = testOutputPath("quint-native-storage-put-recovery");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=60000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    suite,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(
  result.status,
  0,
  "Native storage PUT implementation checks failed",
);

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, 20]],
  "The complete native storage suite must execute",
);
const names = new Set(
  [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)].map(
    (match) => match[1],
  ),
);
for (const name of required) {
  assert(names.has(name), `Missing required native storage case: ${name}`);
}
console.log(
  `Native storage PUT recovery passed ${required.length} required checks within ${summary.executedTests} PGlite tests. Report ${report}`,
);
