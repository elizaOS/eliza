#!/usr/bin/env node
/** Verifies that required Playwright lanes actually executed their intended specs.
 * A successful runner exit alone permits skips and expected failures. This gate
 * consumes the JSON reporter artifact and requires passing terminal attempts,
 * retaining the runner's explicit flaky classification for successful retries.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkRequiredPlaywrightResults(report, requiredFiles) {
  if (!Array.isArray(requiredFiles) || requiredFiles.length === 0) {
    throw new Error("At least one required spec must be named");
  }
  if (
    !Array.isArray(report?.errors) ||
    report.errors.length !== 0 ||
    !Array.isArray(report.suites)
  ) {
    throw new Error(
      "Playwright report is missing results or contains runner errors",
    );
  }
  const counts = { expected: 0, flaky: 0, unexpected: 0, skipped: 0 };
  const executed = new Set();
  function visit(suites, enclosingFile) {
    for (const suite of suites) {
      // File suites identify the selected entrypoint relative to testDir;
      // nested describe locations may instead use resolved helper paths.
      const file = enclosingFile ?? suite.file;
      if (!Array.isArray(suite.specs))
        throw new Error("Invalid Playwright suite");
      for (const spec of suite.specs) {
        if (!Array.isArray(spec.tests) || spec.tests.length === 0)
          throw new Error("Playwright spec has no tests");
        for (const test of spec.tests) {
          if (
            test.expectedStatus !== "passed" ||
            !["expected", "flaky"].includes(test.status) ||
            !Array.isArray(test.results) ||
            test.results.at(-1)?.status !== "passed"
          ) {
            throw new Error(
              `Required Playwright test did not pass: ${suite.file} / ${spec.title} (${test.status})`,
            );
          }
          counts[test.status]++;
          if (typeof file !== "string")
            throw new Error("Playwright result has no spec file");
          executed.add(file.replaceAll("\\", "/"));
        }
      }
      if (suite.suites !== undefined) {
        if (!Array.isArray(suite.suites))
          throw new Error("Invalid nested Playwright suites");
        visit(suite.suites, file);
      }
    }
  }
  visit(report.suites);
  if (counts.expected + counts.flaky === 0)
    throw new Error("Required Playwright lane executed zero tests");
  for (const [name, count] of Object.entries(counts)) {
    if (report.stats?.[name] !== count)
      throw new Error(`Playwright ${name} count disagrees with test results`);
  }
  for (const file of requiredFiles) {
    if (!executed.has(file.replaceAll("\\", "/")))
      throw new Error(`Required Playwright spec was not executed: ${file}`);
  }
  return counts;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [reportFile, ...requiredFiles] = process.argv.slice(2);
  if (!reportFile)
    throw new Error(
      "Usage: check-required-playwright-results.mjs <report.json> <required-spec> [...]",
    );
  const counts = checkRequiredPlaywrightResults(
    JSON.parse(readFileSync(reportFile, "utf8")),
    requiredFiles,
  );
  console.log(
    `[required-playwright] ${counts.expected} passed, ${counts.flaky} passed after retry; all required specs executed`,
  );
}
