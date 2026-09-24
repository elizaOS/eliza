import assert from "node:assert/strict";
import test from "node:test";

import { verifyInstrumentationXml } from "../aosp/verify-android-instrumentation-results.mjs";

const requiredClass = "ai.elizaos.app.ElizaAssistantSurfaceInstrumentedTest";

test("requires a non-skipped retail assistant suite", () => {
  const cases = Array.from(
    { length: 6 },
    (_, index) =>
      `<testcase classname="${requiredClass}" name="case${index}"/>`,
  ).join("");
  const verdict = verifyInstrumentationXml(
    [`<testsuite tests="6" failures="0" errors="0">${cases}</testsuite>`],
    { requiredClass, minTests: 6 },
  );
  assert.equal(verdict.pass, true);
  assert.equal(verdict.requiredTests, 6);
});

test("rejects skipped, missing, and failing retail assistant results", () => {
  const skipped = verifyInstrumentationXml(
    [
      `<testsuite tests="1" failures="1" errors="0"><testcase classname="${requiredClass}" name="case"><skipped/></testcase></testsuite>`,
    ],
    { requiredClass, minTests: 6 },
  );
  assert.equal(skipped.pass, false);
  assert.equal(skipped.requiredSkipped, 1);
  assert.match(skipped.problems.join(" "), /failures=1/);
  assert.match(skipped.problems.join(" "), /expected at least 6/);
});
