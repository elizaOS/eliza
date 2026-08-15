/**
 * Signup-code configuration tests exercise the real environment parser with isolated module caches.
 */

import { afterEach, describe, expect, test } from "bun:test";

const originalSignupCodesJson = process.env.SIGNUP_CODES_JSON;

afterEach(() => {
  if (originalSignupCodesJson === undefined) {
    delete process.env.SIGNUP_CODES_JSON;
  } else {
    process.env.SIGNUP_CODES_JSON = originalSignupCodesJson;
  }
});

describe("signup-code configuration", () => {
  test("rejects partially numeric bonus amounts", async () => {
    process.env.SIGNUP_CODES_JSON = JSON.stringify({
      codes: { launch: "25credits", infinite: "Infinity", valid: "25" },
    });

    const { getBonusForCode } = await import("./signup-code?invalid-partial-amount");

    expect(getBonusForCode("launch")).toBeUndefined();
    expect(getBonusForCode("infinite")).toBeUndefined();
    expect(getBonusForCode("valid")).toBe(25);
  });
});
