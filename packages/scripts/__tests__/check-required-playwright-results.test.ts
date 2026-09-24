/** Exercises required-lane admission with JSON emitted by the real Playwright runner.
 * Browser-free fixture tests cover successful execution, skips, expected failures,
 * retries, empty selections, missing specs, and corrupted report summaries.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkRequiredPlaywrightResults } from "../check-required-playwright-results.mjs";

const require = createRequire(import.meta.url);
const directory = mkdtempSync(path.join(tmpdir(), "required-playwright-"));
const playwright = pathToFileURL(
  path.join(
    path.dirname(require.resolve("@playwright/test/package.json")),
    "index.mjs",
  ),
).href;
const config = path.join(directory, "playwright.config.mjs");
writeFileSync(
  config,
  'export default { testDir: ".", workers: 1, retries: 1 };',
);
writeFileSync(
  path.join(directory, "chat.spec.mjs"),
  `
import { test, expect } from ${JSON.stringify(playwright)};
test.describe("local onboarding", () => {
test("required chat", async ({}, info) => {
  const mode = process.env.REQUIRED_PLAYWRIGHT_CASE;
  test.skip(mode === "skip", "fixture without provider");
  test.fail(mode === "expected-failure", "fixture expected failure");
  expect(mode === "fail" || mode === "expected-failure" || (mode === "flaky" && info.retry === 0)).toBe(false);
});
});
`,
);
after(() => rmSync(directory, { recursive: true, force: true }));

function run(mode) {
  const reportFile = path.join(directory, `${mode}.json`);
  const result = spawnSync(
    "node",
    [
      require.resolve("@playwright/test/cli"),
      "test",
      "--config",
      config,
      "--reporter=json",
      ...(mode === "empty"
        ? ["--grep", "absent-test", "--pass-with-no-tests"]
        : []),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        REQUIRED_PLAYWRIGHT_CASE: mode,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, mode === "fail" ? 1 : 0, result.stderr);
  return JSON.parse(readFileSync(reportFile, "utf8"));
}

test("requires real passing execution and preserves successful retry classification", {
  timeout: 60_000,
}, () => {
  const report = run("pass");
  assert.equal(
    checkRequiredPlaywrightResults(report, ["chat.spec.mjs"]).expected,
    1,
  );
  assert.throws(
    () => checkRequiredPlaywrightResults(report, ["missing.spec.mjs"]),
    /not executed/,
  );
  report.stats.expected++;
  assert.throws(
    () => checkRequiredPlaywrightResults(report, ["chat.spec.mjs"]),
    /count disagrees/,
  );
  assert.equal(
    checkRequiredPlaywrightResults(run("flaky"), ["chat.spec.mjs"]).flaky,
    1,
  );
});

test("rejects skipped, failed, expected-failure, and empty runs even when runner exit is zero", {
  timeout: 60_000,
}, () => {
  for (const mode of ["skip", "fail", "expected-failure", "empty"]) {
    assert.throws(
      () => checkRequiredPlaywrightResults(run(mode), ["chat.spec.mjs"]),
      /did not pass|zero tests/,
    );
  }
  assert.throws(
    () => checkRequiredPlaywrightResults({}, ["chat.spec.mjs"]),
    /missing results/,
  );
});
