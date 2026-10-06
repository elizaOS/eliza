import { expect, test } from "bun:test";
import { parseReferralMeResponse } from "./contracts.js";

test("referral wire parser accepts database count representations and rejects imprecise or malformed counts", () => {
  for (const value of [0, 12, "12", 12n]) {
    expect(
      parseReferralMeResponse({
        code: "invite",
        total_referrals: value,
        is_active: true,
      })?.total_referrals,
    ).toBe(Number(value));
  }
  for (const value of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
    "01",
    "-1",
    "1.5",
    "9007199254740992",
    9007199254740992n,
    null,
    true,
  ]) {
    expect(
      parseReferralMeResponse({
        code: "invite",
        total_referrals: value,
        is_active: true,
      }),
    ).toBeNull();
  }
  expect(
    parseReferralMeResponse({ code: "", total_referrals: 0, is_active: true }),
  ).toBeNull();
  expect(
    parseReferralMeResponse({
      code: "invite",
      total_referrals: 0,
      is_active: "true",
    }),
  ).toBeNull();
});
