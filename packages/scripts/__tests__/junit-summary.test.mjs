/** Exercises bounded JUnit reconciliation against Bun and Vitest shapes. */

import { describe, expect, test } from "bun:test";
import { MAX_JUNIT_BYTES, parseJunitSummary } from "../lib/junit-summary.mjs";

const bunNested = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="1" failures="0" skipped="1">
  <testsuite name="example.test.ts" tests="2" assertions="1" failures="0" skipped="1">
    <testsuite name="group" tests="2" assertions="1" failures="0" skipped="1">
      <testcase name="runs" assertions="1" />
      <testcase name="gated" assertions="0"><skipped /></testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

const vitestFlat = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0">
  <testsuite name="example.test.ts" tests="2" failures="0" errors="0" skipped="2">
    <testcase name="first"><skipped /></testcase>
    <testcase name="second"><skipped /></testcase>
  </testsuite>
</testsuites>`;

describe("parseJunitSummary", () => {
  test("reconciles nested Bun suites without double-counting", () => {
    expect(parseJunitSummary(bunNested)).toEqual({
      tests: 2,
      failures: 0,
      errors: 0,
      skipped: 1,
      executedTests: 1,
    });
  });

  test("identifies a Vitest selection whose every testcase skipped", () => {
    expect(parseJunitSummary(vitestFlat)).toEqual({
      tests: 2,
      failures: 0,
      errors: 0,
      skipped: 2,
      executedTests: 0,
    });
  });

  test("rejects count smuggling and unsafe XML structure", () => {
    expect(() =>
      parseJunitSummary(bunNested.replace('skipped="1">', 'skipped="0">')),
    ).toThrow("does not match nested skipped=1");
    expect(() =>
      parseJunitSummary(
        `<!DOCTYPE testsuites [<!ENTITY hidden "testcase">]>${bunNested}`,
      ),
    ).toThrow("may not contain a DOCTYPE");
    expect(() =>
      parseJunitSummary(
        '<testsuites tests="1" failures="0"><testcase name="hidden" /></testsuites>',
      ),
    ).toThrow("<testcase> under <testsuites>");
  });

  test("rejects reports beyond the resource budget", () => {
    expect(() => parseJunitSummary("x".repeat(MAX_JUNIT_BYTES + 1))).toThrow(
      `exceeds ${MAX_JUNIT_BYTES} bytes`,
    );
  });
});
