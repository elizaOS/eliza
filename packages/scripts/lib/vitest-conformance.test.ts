import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { requireVitestConformance } from "./vitest-conformance.ts";

const file = path.resolve("fixture.test.ts");
const names = ["first required case", "second required case"];
function report() {
  return {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    testResults: [
      {
        name: file,
        status: "passed",
        assertionResults: names.map((fullName) => ({
          fullName,
          status: "passed",
          failureMessages: [] as string[],
        })),
      },
    ],
  };
}

test("accepts the complete named suite", () => {
  assert.equal(requireVitestConformance(report(), file, names).length, 2);
});

test("rejects empty or only-filtered reports even when Vitest exits successfully", () => {
  for (const count of [0, 1]) {
    const data = report();
    data.numTotalTests = count;
    data.numPassedTests = count;
    data.testResults[0].assertionResults =
      data.testResults[0].assertionResults.slice(0, count);
    assert.throws(() => requireVitestConformance(data, file, names));
  }
});

test("rejects an all-skipped successful report", () => {
  const data = report();
  data.numPassedTests = 0;
  data.numPendingTests = 2;
  data.testResults[0].assertionResults.forEach((item) => {
    item.status = "pending";
  });
  assert.throws(() => requireVitestConformance(data, file, names));
});

test("rejects missing, duplicate and renamed required assertions", () => {
  for (const replacement of ["first required case", "renamed case"]) {
    const data = report();
    data.testResults[0].assertionResults[1].fullName = replacement;
    assert.throws(() => requireVitestConformance(data, file, names));
  }
});

test("rejects failed, todo and skipped required assertions", () => {
  for (const status of ["failed", "todo", "pending", "skipped"]) {
    const data = report();
    data.testResults[0].assertionResults[1].status = status;
    assert.throws(() => requireVitestConformance(data, file, names));
  }
});

test("rejects a stale report from another file and hidden failure evidence", () => {
  const stale = report();
  stale.testResults[0].name = path.resolve("other.test.ts");
  assert.throws(() => requireVitestConformance(stale, file, names));
  const failure = report();
  failure.testResults[0].assertionResults[0].failureMessages = [
    "late teardown failed",
  ];
  assert.throws(() => requireVitestConformance(failure, file, names));
});

test("allows only explicitly named platform skips and reconciles the counters", () => {
  const data = report();
  data.numPassedTests = 1;
  data.numPendingTests = 1;
  data.testResults[0].assertionResults[1].status = "pending";
  assert.equal(
    requireVitestConformance(data, file, names, [names[1]]).length,
    2,
  );
  assert.throws(() => requireVitestConformance(data, file, names, [names[0]]));
  assert.throws(() => requireVitestConformance(data, file, names, ["unknown"]));
});
