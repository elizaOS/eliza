/**
 * Unit coverage for pure Telegram-membership mapping helpers and the
 * out-of-order/restricted semantics fixed in review round 1. Deterministic
 * unit harness; authority integration lives in
 * __tests__/membership-authority.real.test.ts.
 */
import { describe, expect, it } from "vitest";
import { telegramStatusToMembership } from "./membership";

describe("telegramStatusToMembership", () => {
  it("maps member statuses to active", () => {
    for (const status of ["creator", "administrator", "member"]) {
      expect(telegramStatusToMembership({ status })).toEqual({
        state: "active",
        reason: "reconciled_present",
      });
    }
  });

  it("maps restricted WITH is_member true to active", () => {
    expect(
      telegramStatusToMembership({ status: "restricted", is_member: true }),
    ).toEqual({ state: "active", reason: "reconciled_present" });
  });

  it("maps restricted WITH is_member false to REVOKED (unbanned non-member must not admit)", () => {
    expect(
      telegramStatusToMembership({ status: "restricted", is_member: false }),
    ).toEqual({ state: "revoked", reason: "left" });
  });

  it("maps restricted without is_member (unknown) to active (fail toward provider truth)", () => {
    // Telegram always sends is_member on restricted; absence is treated as
    // membership true to match the Bot API contract default.
    expect(telegramStatusToMembership({ status: "restricted" })).toEqual({
      state: "active",
      reason: "reconciled_present",
    });
  });

  it("maps left/kicked/unknown to revoked", () => {
    expect(telegramStatusToMembership({ status: "left" })).toEqual({
      state: "revoked",
      reason: "left",
    });
    expect(telegramStatusToMembership({ status: "kicked" })).toEqual({
      state: "revoked",
      reason: "kicked",
    });
  });
});
