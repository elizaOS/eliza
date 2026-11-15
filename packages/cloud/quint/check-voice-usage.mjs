/** Run the production voice quota and socket admission paths in Workerd. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "VoiceUsage.qnt"),
  "Voice usage conformance requires its own model path",
);
const suite = "packages/cloud/api/__tests__/voice-usage-state-workerd.test.ts";
const expected = [
  "concurrent users cannot overspend the shared organization quota, including after restart",
  "user limits, rounding, releases and day rollover preserve accounting",
  "transfer retains scaled usage and rejects conflicting or post-activation snapshots",
  "expired imported counters grant no stale usage and imports cannot cross organizations",
  "missing selected binding fails even when local mock Redis is configured",
  "both production socket routes reject missing metering before upgrade",
  "production sockets cannot use the local Redis mock as quota authority",
];
const output = testOutputPath("quint-voice-usage");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "240000",
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
assert.equal(result.status, 0, "Voice usage implementation checks failed");
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, expected.length]],
  "The voice usage Workerd suite must execute",
);
const names = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)].map(
  (match) => match[1],
);
assert.deepEqual(
  names.sort(),
  expected.sort(),
  "Every required voice usage test must execute",
);
console.log(
  `Voice usage passed ${names.length} Workerd checks. Report ${report}`,
);
