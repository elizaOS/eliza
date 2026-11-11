/** Check mobile key renewal against the real route, services and SQL in PGlite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("quint-mobile-key-renewal");
mkdirSync(output, { recursive: true });
const report = path.join(mkdtempSync(path.join(output, "run-")), "results.xml");
const result = spawnSync(
  "bun",
  [
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=60000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    "packages/cloud/api/__tests__/mobile-app-auth-renewal.pglite.test.ts",
  ],
  { cwd: root, stdio: "inherit" },
);
assert.ifError(result.error);
assert.equal(result.status, 0);
const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors, 0);
assert.equal(summary.executedTests, 12);
for (const name of [
  "an acknowledged key renews into a successor that keeps the sign-in time",
  "renewal stops with 409 once the sign-in is older than the 180-day cap",
  "a grant from before the column counts the cap from its creation",
  "a replayed renewal cannot extend the cap, and a revoked predecessor cannot renew again",
  "a key revoked or a client deactivated after authorization issues no code",
]) {
  assert(xml.includes(`name="${name}"`), `Missing renewal check: ${name}`);
}
console.log("Mobile key renewal route, service and SQL checks passed.");
