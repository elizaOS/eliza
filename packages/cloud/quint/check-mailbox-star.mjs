import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("quint-mailbox-star");
mkdirSync(output, { recursive: true });
const report = path.join(mkdtempSync(path.join(output, "run-")), "results.xml");
const result = spawnSync(
  "bun",
  [
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--timeout=60000",
    "--test-name-pattern=bounded attachments round-trip|read-state migration|Google mailbox changes",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    "packages/cloud/shared/src/lib/services/agent-google-connector/inbox-provider.http.integration.test.ts",
    "packages/cloud/shared/src/lib/services/oauth/provider-registry.google-scopes.test.ts",
  ],
  { cwd: root, stdio: "inherit" },
);
assert.ifError(result.error);
assert.equal(result.status, 0);
const summary = parseJunitSummary(readFileSync(report, "utf8"));
assert.equal(summary.failures + summary.errors, 0);
assert.equal(summary.executedTests, 3);
console.log("Mailbox star HTTP and receipt migration checks passed.");
