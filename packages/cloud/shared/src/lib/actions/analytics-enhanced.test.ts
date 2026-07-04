/**
 * Fail-closed coverage for analytics projection credit-balance reads (#12788).
 */

import { describe, expect, test } from "bun:test";
import type { Organization } from "../../db/schemas/organizations";
import { parseProjectionCreditBalance } from "./analytics-enhanced";

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";

function orgWithBalance(credit_balance: unknown): Organization {
  return { id: ORG_ID, credit_balance } as unknown as Organization;
}

describe("parseProjectionCreditBalance", () => {
  test("parses a valid numeric-string balance", () => {
    expect(parseProjectionCreditBalance(orgWithBalance("12.500000"), ORG_ID)).toBe(12.5);
  });

  test("throws when the authenticated organization row is missing", () => {
    expect(() => parseProjectionCreditBalance(undefined, ORG_ID)).toThrow(/not found/);
  });

  test("throws on null balance instead of fabricating zero", () => {
    expect(() => parseProjectionCreditBalance(orgWithBalance(null), ORG_ID)).toThrow(
      /credit_balance/,
    );
  });

  test("throws on non-numeric balance instead of returning NaN", () => {
    expect(() => parseProjectionCreditBalance(orgWithBalance("not-a-number"), ORG_ID)).toThrow(
      /credit_balance/,
    );
  });

  test("throws on partially numeric corrupt balance strings", () => {
    expect(() => parseProjectionCreditBalance(orgWithBalance("12.5oops"), ORG_ID)).toThrow(
      /credit_balance/,
    );
  });
});
