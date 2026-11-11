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
assert.equal(summary.executedTests, 17);
for (const name of [
  "an acknowledged key renews into a successor that keeps the sign-in time",
  "both credential headers are accepted only when they carry the same key, on renewal and on self-revocation",
  "renewal stops with 409 at the 180-day cap, and no key outlives it",
  "the credential expiry rule never passes the sign-in&apos;s cap",
  "a grant from before the columns counts the cap from its creation and becomes its own session",
  "a repeated renewal supersedes the code still in flight, and a revoked predecessor cannot renew again",
  "a code issued before its key was revoked mints and activates nothing",
  "a key that renews after its successor was acknowledged ends the whole sign-in",
  "revoking a device ends its sign-in, while a renewal&apos;s last step ends only the old key",
  "a key revoked or a client deactivated after authorization issues no code",
]) {
  assert(xml.includes(`name="${name}"`), `Missing renewal check: ${name}`);
}
console.log("Mobile key renewal route, service and SQL checks passed.");
