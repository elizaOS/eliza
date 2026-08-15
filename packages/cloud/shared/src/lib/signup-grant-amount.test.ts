/**
 * The opening-balance policy stays zero across every runtime environment.
 * Explicit funding and promotion paths have their own independently tested ledgers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { SIGNUP_CREDIT_POLICY } from "./signup-credits";

const originalInitialFreeCredits = process.env.INITIAL_FREE_CREDITS;

afterEach(() => {
  if (originalInitialFreeCredits === undefined) {
    delete process.env.INITIAL_FREE_CREDITS;
  } else {
    process.env.INITIAL_FREE_CREDITS = originalInitialFreeCredits;
  }
});

describe("signup credit policy", () => {
  test("opens every new organization at zero without an automatic grant", () => {
    expect(SIGNUP_CREDIT_POLICY).toEqual({
      automaticGrantUsd: 0,
      openingBalanceUsd: "0.00",
    });
  });

  test("cannot be re-enabled by the retired environment override", () => {
    process.env.INITIAL_FREE_CREDITS = "5";
    expect(SIGNUP_CREDIT_POLICY.automaticGrantUsd).toBe(0);
    expect(SIGNUP_CREDIT_POLICY.openingBalanceUsd).toBe("0.00");
  });
});
