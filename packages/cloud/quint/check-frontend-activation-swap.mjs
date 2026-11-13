/** Run both maintained deployment races against the real SQL repository. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "FrontendActivationSwap.qnt"),
);
const suite =
  "packages/cloud/api/v1/apps/[id]/frontend/[deploymentId]/route.activate-race.pglite.test.ts";
const output = testOutputPath("quint-frontend-activation-swap");
mkdirSync(output, { recursive: true });
const report = path.join(mkdtempSync(path.join(output, "run-")), "results.xml");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=30000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    suite,
  ],
  { cwd: root, stdio: "inherit" },
);
if (child.error) throw child.error;
assert.equal(child.status, 0, "Frontend deployment races failed");
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors + summary.skipped, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, 2]],
);
assert.deepEqual(
  [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
    .map((match) => match[1])
    .sort(),
  [
    "a delete that lands during a rollback leaves the current deployment live",
    "a rollback that lands during a delete keeps the rolled-back deployment live",
  ],
);
console.log(`Both frontend deployment races passed. Report ${report}`);
