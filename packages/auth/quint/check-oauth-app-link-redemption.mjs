/** Check the issued-code route against the maintained native App Link suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJunitSummary } from "../../scripts/lib/junit-summary.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(import.meta.dirname, "OAuthAppLinkRedemption.qnt"),
  "App Link OAuth conformance requires its own model path",
);
const suite =
  "packages/auth/src/server/__tests__/native-app-link-oauth.integration.test.ts";
const required = [
  "Google round trip returns code+state to the App Link and redeems once with the verifier",
  "a hand-off code expires and cannot be redeemed late",
  "mfa=exchange returns a TOTP account's challenge through the PKCE exchange",
];
const output = testOutputPath("quint-oauth-app-link-redemption");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "results.xml");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    "bun",
    "test",
    "--isolate",
    "--conditions=eliza-source",
    "--test-name-pattern",
    required.map((name) => RegExp.escape(name)).join("|"),
    "--reporter=junit",
    `--reporter-outfile=${report}`,
    suite,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "App Link OAuth implementation checks failed");

const xml = readFileSync(report, "utf8");
const summary = parseJunitSummary(xml);
assert.equal(summary.failures + summary.errors, 0);
assert.deepEqual(
  summary.files.map(({ file, executedTests }) => [file, executedTests]),
  [[suite, required.length]],
  "All required App Link OAuth implementation checks must execute",
);
console.log(
  `App Link OAuth passed ${required.length} checks. Report ${report}`,
);
