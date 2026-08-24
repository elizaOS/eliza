/**
 * Unit tests for use-dashboard-referral-me: validates hook export.
 */
import { describe, expect, it } from "vitest";
import { useDashboardReferralMe } from "./use-dashboard-referral-me.ts";

describe("use-dashboard-referral-me", () => {
  it("exports useDashboardReferralMe hook function", () => {
    expect(typeof useDashboardReferralMe).toBe("function");
  });
});
