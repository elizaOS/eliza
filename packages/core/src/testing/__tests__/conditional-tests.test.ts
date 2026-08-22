import { describe, expect, it, test } from "vitest";
import { describeIf, itIf, testIf } from "./conditional-tests.ts";

describe("conditional-tests", () => {
  it("describeIf(true) returns the real describe", () => {
    expect(describeIf(true)).toBe(describe);
  });

  it("describeIf(false) returns a different (skip) registrar", () => {
    const fn = describeIf(false);
    expect(typeof fn).toBe("function");
    expect(fn).not.toBe(describe);
  });

  it("itIf(true) returns the real it", () => {
    expect(itIf(true)).toBe(it);
  });

  it("itIf(false) returns a different (skip) registrar", () => {
    const fn = itIf(false);
    expect(typeof fn).toBe("function");
    expect(fn).not.toBe(it);
  });

  it("testIf(true/false) mirrors itIf", () => {
    expect(testIf(true)).toBe(test);
    const skipFn = testIf(false);
    expect(typeof skipFn).toBe("function");
    expect(skipFn).not.toBe(test);
  });
});
