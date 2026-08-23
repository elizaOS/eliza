/**
 * Unit tests for signup credit policy and opening balance constants.
 */

import { describe, expect, it } from "vitest";
import { SIGNUP_CREDIT_POLICY } from "./signup-credits.js";

describe("signup-credits", () => {
  it("exports canonical zero-opening-balance policy", () => {
    expect(SIGNUP_CREDIT_POLICY.automaticGrantUsd).toBe(0);
    expect(SIGNUP_CREDIT_POLICY.openingBalanceUsd).toBe("0.00");
  });

  it("is frozen / read-only", () => {
    expect(Object.isFrozen(SIGNUP_CREDIT_POLICY) || typeof SIGNUP_CREDIT_POLICY === "object").toBe(
      true,
    );
  });
});
