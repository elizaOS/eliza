/** Run the required Durable Object lease and PGlite direct recovery cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "StandardInferenceAdmission.qnt"),
  "Standard inference conformance requires its own model path",
);
const suites = new Map([
  [
    "packages/cloud/api/__tests__/inference-admission-gate.miniflare.test.ts",
    5,
  ],
  [
    "packages/cloud/shared/src/lib/services/inference-admission-recovery.pglite.test.ts",
    3,
  ],
]);
const required = [
  "real Durable Object serialization prevents concurrent overspend",
  "authorized lease checks revocation and balance in one Durable Object request",
  "snapshot admissions under a superseded policy generation fail closed at lease and dispatch",
  "lost dispatch acknowledgment replays one real durable lease without a second hold",
  "actual DO zero release emits exact identity only after its explicit acknowledgement",
  "direct recovery debits once and replays the same accounting result",
  "a post-commit callback failure returns no recovery result and replays without another debit",
  "a database failure rolls back the debit and ledger claim",
];
const pattern = `(?:${required.map((name) => RegExp.escape(name)).join("|")})$`;
const output = testOutputPath("quint-standard-inference-admission");
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
    "--test-name-pattern",
    pattern,
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
  "Standard inference implementation checks failed",
);

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors, 0);
assert.deepEqual(
  new Map(
    summary.files.map(({ file, executedTests }) => [file, executedTests]),
  ),
  suites,
  "Both standard inference implementation suites must execute",
);
const names = new Set(
  [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
    .filter((match) => !/<skipped\b/.test(match[2] ?? ""))
    .map((match) => match[1].match(/\bname="([^"]+)"/)?.[1]),
);
for (const name of required) {
  assert(names.has(name), `Missing required standard inference case: ${name}`);
}
console.log(
  `Standard inference passed ${summary.executedTests} required Workerd and PGlite checks. Report ${report}`,
);
