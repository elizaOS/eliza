/** Exercise the production coordinator with real Workerd durable storage. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(root, process.argv[2] ?? "");
assert.equal(path.dirname(model), import.meta.dirname);
assert(
  [
    "OnboardingGreetingLease.qnt",
    "OnboardingContinuationClaim.qnt",
    "OnboardingReplayCleanup.qnt",
  ].includes(path.basename(model)),
  "Expected an onboarding coordinator model",
);
const suite =
  "packages/cloud/api/__tests__/onboarding-coordinator-errors.miniflare.test.ts";
const expected = [
  "public route maps a typed coordinator rejection to fail-closed 403",
  "concurrent greeting drains lease the original enqueue to one poller",
  "an expired lease can be replaced and its delayed acknowledgement has no effect",
  "continuation pins the original lineage and account through exact completion",
  "continuation rejects invalid sessions and recovers a retained completed claim",
  "replay created behind the cleanup cursor keeps an expiry alarm",
];
const output = testOutputPath("quint-onboarding-coordinator");
mkdirSync(output, { recursive: true });
const report = path.join(mkdtempSync(path.join(output, "run-")), "results.xml");
const child = spawnSync(
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
if (child.error) throw child.error;
assert.equal(child.status, 0, "Onboarding coordinator checks failed");
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, expected.length]],
);
assert.deepEqual(
  [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
    .map((match) => match[1])
    .sort(),
  expected.sort(),
);
console.log(
  `Onboarding coordinator passed ${expected.length} Workerd checks. Report ${report}`,
);
