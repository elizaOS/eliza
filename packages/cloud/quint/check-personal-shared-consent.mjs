/** Run the actual Personal Shared consent and delivery SQL in PGlite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "PersonalSharedConsent.qnt"),
  "Personal Shared conformance requires its own model path",
);
const repository = "packages/cloud/shared/src/db/repositories";
const suites = new Map([
  [`${repository}/personal-shared-group-consent.integration.test.ts`, 29],
  [`${repository}/personal-shared-groups.integration.test.ts`, 11],
]);
const required = [
  "account deactivation revokes consent durably and reactivation cannot resurrect it",
  "a live uncommitted delivery lease rejects account mutation without partial revocation",
  "serializes confirmation against account deactivation without consent resurrection",
  "fails closed below all-adults quorum but permits explicit consent-control delivery",
  "refuses commit when all-adults eligibility is lost after authorization",
  "keeps a same-owner reconnect claim retryable across delivery leases",
  "lets authority change after commit and reconciles only the exact late receipt",
  "fences an expired worker after the exact source delivery is reacquired",
  "preserves an uncertain accepted send while allowing distinct future delivery and late reconciliation",
];
const output = testOutputPath("quint-personal-shared-consent");
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
assert.equal(result.status, 0, "Personal Shared implementation checks failed");

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  new Map(
    summary.files.map(({ file, executedTests }) => [file, executedTests]),
  ),
  suites,
  "Both Personal Shared implementation suites must execute",
);
const names = new Set(
  [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)].map(
    (match) => match[1],
  ),
);
for (const name of required) {
  assert(names.has(name), `Missing required Personal Shared case: ${name}`);
}
console.log(
  `Personal Shared passed ${required.length} required checks within ${summary.executedTests} PGlite tests. Report ${report}`,
);
