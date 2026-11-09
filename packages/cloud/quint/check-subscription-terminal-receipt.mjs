/** Exercise terminal event receipt and lifecycle publication SQL in PGlite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "SubscriptionTerminalReceipt.qnt"),
  "Subscription terminal receipt conformance requires its own model path",
);
const repository = "packages/cloud/shared/src/db/repositories";
const suites = new Map([
  [`${repository}/subscription-billing-operations.pglite.test.ts`, 21],
  [`${repository}/subscription-lifecycle-finalization.pglite.test.ts`, 26],
  [`${repository}/subscription-reconciliation.pglite.test.ts`, 20],
]);
const required = [
  "platform command dispatch refuses stale or foreign authority and preserves its first fence",
  "platform command failure replay requires the original generation and exact terminal evidence",
  "platform command supersession retires only a prepared intent with exact replay",
  "platform checkout application requires matching retained history and replays only its original result",
  "platform cancel and resume require their dedicated dispatch protocol",
  "platform command original provider identity is protected by the database",
  "deduplicates exact provider events and lease-CAS applies one revision",
  "commits lifecycle, current projection and receipt before billing admission sees Free",
  "notice insertion failure rolls back source, projection, receipt, generation and audit together",
  "a projection failure rolls back the lifecycle journal and leaves the receipt retryable",
  "a receipt failure rolls back both lifecycle and projection",
  "audit insertion failure rolls back lifecycle, projection, generation and receipt",
  "lease expiration after projection still rolls back every domain write",
  "a lease that expired during provider retrieval cannot write domain state",
  "stale source and stale projection CAS cannot be hidden by lifecycle replay",
  "finishing an already published terminal observation preserves generation and audit",
  "response-loss replay returns historical receipt without overwriting a replacement's admission",
  "deleted-account, cross-tenant and unavailable authority cannot finalize",
  "actual SDK recovery publishes terminal once and the published terminal source leaves the scan",
  "late authentic terminal queue event applies only its receipt and replay preserves reconciled watermark",
];
const output = testOutputPath("quint-subscription-terminal-receipt");
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
    ...suites.keys(),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(
  result.status,
  0,
  "Subscription terminal receipt implementation checks failed",
);

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  new Map(
    summary.files.map(({ file, executedTests }) => [file, executedTests]),
  ),
  suites,
  "All subscription receipt implementation suites must execute",
);
const names = new Set(
  [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)].map((match) =>
    match[1].replaceAll("&apos;", "'"),
  ),
);
for (const name of required) {
  assert(
    names.has(name),
    `Missing required subscription receipt case: ${name}`,
  );
}
console.log(
  `Subscription terminal receipt passed ${required.length} required checks within ${summary.executedTests} PGlite tests. Report ${report}`,
);
