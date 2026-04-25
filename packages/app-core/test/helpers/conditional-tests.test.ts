import { describe, expect, it } from "vitest";

import { describeIf, itIf, testIf } from "./conditional-tests.ts";

let disabledSuiteCallbackRan = false;
let disabledItCallbackRan = false;
let disabledTestCallbackRan = false;

describeIf(false)("disabled describeIf suite", () => {
  disabledSuiteCallbackRan = true;
});

itIf(false)("disabled itIf test", () => {
  disabledItCallbackRan = true;
});

testIf(false)("disabled testIf test", () => {
  disabledTestCallbackRan = true;
});

describe("conditional test helpers", () => {
  it("does not execute disabled suite or test callbacks", () => {
    expect(disabledSuiteCallbackRan).toBe(false);
    expect(disabledItCallbackRan).toBe(false);
    expect(disabledTestCallbackRan).toBe(false);
  });
});
