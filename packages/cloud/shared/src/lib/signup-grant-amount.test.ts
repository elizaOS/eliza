/**
 * The opening-balance policy stays fixed across every runtime environment.
 * Explicit funding and promotion paths have their own independently tested ledgers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { isUntouchedSignupOpeningBalance, SIGNUP_CREDIT_POLICY } from "./signup-credits";

const originalInitialFreeCredits = process.env.INITIAL_FREE_CREDITS;

afterEach(() => {
  if (originalInitialFreeCredits === undefined) {
    delete process.env.INITIAL_FREE_CREDITS;
  } else {
    process.env.INITIAL_FREE_CREDITS = originalInitialFreeCredits;
  }
});

describe("signup credit policy", () => {
  test("opens every new organization with the fixed signup credit", () => {
    expect(SIGNUP_CREDIT_POLICY).toEqual({
      automaticGrantUsd: 5,
      openingBalanceUsd: "5.00",
      legacyOpeningBalanceUsd: 0,
    });
  });

  test("cannot be changed by the retired environment override", () => {
    process.env.INITIAL_FREE_CREDITS = "99";
    expect(SIGNUP_CREDIT_POLICY.automaticGrantUsd).toBe(5);
    expect(SIGNUP_CREDIT_POLICY.openingBalanceUsd).toBe("5.00");
  });

  test("recognizes only untouched current and legacy opening balances", () => {
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 0, balanceRevision: 0 })).toBe(true);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 5, balanceRevision: 0 })).toBe(true);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 2, balanceRevision: 0 })).toBe(false);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 0, balanceRevision: 1 })).toBe(false);
    expect(isUntouchedSignupOpeningBalance({ balanceUsd: 5, balanceRevision: 1 })).toBe(false);
  });
});
