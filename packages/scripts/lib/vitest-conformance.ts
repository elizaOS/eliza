/** Requires the complete named implementation suite in a Vitest JSON report. */
import assert from "node:assert/strict";
import path from "node:path";

interface AssertionResult {
  fullName: string;
  status: string;
  failureMessages: string[];
}
interface VitestReport {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  numFailedTestSuites: number;
  testResults: Array<{
    name: string;
    status: string;
    assertionResults: AssertionResult[];
  }>;
}

export function requireVitestConformance(
  value: unknown,
  testFile: string,
  requiredNames: readonly string[],
  skippedNames: readonly string[] = [],
): Array<{ name: string; status: string }> {
  assert(value && typeof value === "object", "Missing Vitest JSON report");
  const report = value as VitestReport;
  const required = new Set(requiredNames);
  const skipped = new Set(skippedNames);
  assert(required.size > 0, "Conformance must require concrete tests");
  assert.equal(
    required.size,
    requiredNames.length,
    "Duplicate required test name",
  );
  assert.equal(
    skipped.size,
    skippedNames.length,
    "Duplicate skipped test name",
  );
  for (const name of skipped)
    assert(required.has(name), `Unknown skipped test ${name}`);
  assert.equal(report.success, true, "Vitest did not report success");
  assert.equal(report.numFailedTests, 0, "Conformance has failed tests");
  assert.equal(report.numFailedTestSuites, 0, "Conformance has failed suites");
  assert.equal(report.numTodoTests, 0, "Conformance has todo tests");
  assert.equal(
    report.numTotalTests,
    required.size,
    "Conformance test count changed",
  );
  assert.equal(
    report.numPassedTests,
    required.size - skipped.size,
    "Required conformance tests did not pass",
  );
  assert.equal(
    report.numPendingTests,
    skipped.size,
    "Unexpected skipped conformance tests",
  );
  assert(Array.isArray(report.testResults), "Missing conformance file results");
  assert.equal(
    report.testResults.length,
    1,
    "Expected exactly one conformance file",
  );
  const file = report.testResults[0];
  assert(file, "Missing conformance file");
  assert.equal(
    path.resolve(file.name),
    path.resolve(testFile),
    "Unexpected conformance file",
  );
  assert.equal(file.status, "passed", "Conformance file did not pass");
  assert(
    Array.isArray(file.assertionResults),
    "Missing conformance assertions",
  );
  assert.equal(
    file.assertionResults.length,
    required.size,
    "Missing required conformance assertions",
  );
  const names = file.assertionResults.map((result) => result.fullName);
  assert.equal(
    new Set(names).size,
    names.length,
    "Duplicate conformance assertion",
  );
  assert.deepEqual(
    [...names].sort(),
    [...required].sort(),
    "Conformance test identities changed",
  );
  return file.assertionResults.map((result) => {
    assert.equal(
      result.status,
      skipped.has(result.fullName) ? "pending" : "passed",
      `Unexpected status for ${result.fullName}`,
    );
    assert(
      Array.isArray(result.failureMessages),
      `Missing failure evidence for ${result.fullName}`,
    );
    assert.equal(
      result.failureMessages.length,
      0,
      `Failure evidence for ${result.fullName}`,
    );
    return { name: result.fullName, status: result.status };
  });
}
