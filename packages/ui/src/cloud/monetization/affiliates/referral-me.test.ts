/**
 * Unit tests for referral-me: validates response schema parser and count coercion.
 */
import { describe, expect, it } from "vitest";
import {
  parseReferralMeResponse,
  REFERRALS_ME_API_PATH,
} from "./referral-me.ts";

describe("referral-me", () => {
  it("exports canonical referrals me api path", () => {
    expect(REFERRALS_ME_API_PATH).toBe("/api/v1/referrals");
  });

  it("parses valid referral response object", () => {
    const parsed = parseReferralMeResponse({
      code: "REF123",
      total_referrals: 5,
      is_active: true,
    });
    expect(parsed).toEqual({
      code: "REF123",
      total_referrals: 5,
      is_active: true,
    });
  });

  it("coerces string referral count into integer", () => {
    const parsed = parseReferralMeResponse({
      code: "REF456",
      total_referrals: "10",
      is_active: false,
    });
    expect(parsed?.total_referrals).toBe(10);
  });

  it("returns null for invalid shapes or missing required fields", () => {
    expect(parseReferralMeResponse(null)).toBeNull();
    expect(parseReferralMeResponse({})).toBeNull();
    expect(
      parseReferralMeResponse({
        code: "",
        total_referrals: 0,
        is_active: true,
      }),
    ).toBeNull();
    expect(
      parseReferralMeResponse({
        code: "CODE",
        total_referrals: -1,
        is_active: true,
      }),
    ).toBeNull();
  });
});
