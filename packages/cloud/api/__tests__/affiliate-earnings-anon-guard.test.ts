/**
 * Money-leak guard (#10853): anonymous free-tier chat charges $0, so affiliate
 * earnings must NOT be credited from anonymous requests — otherwise an attacker
 * with an active affiliate code POSTs /api/v1/chat unauthenticated with
 * X-Affiliate-Code=<own code> and mints cashable redeemable balance from nothing.
 *
 * Drives the REAL `shouldCreditAffiliateEarnings` gate (the exact predicate the
 * billing paths use before calling redeemableEarningsService.addEarnings).
 */
import { describe, expect, test } from "bun:test";
import { shouldCreditAffiliateEarnings } from "@/lib/services/affiliate-earnings-guard";
import type { BillingContext } from "@/lib/services/ai-billing";

const ctx = (over: Partial<BillingContext>): BillingContext => ({
  organizationId: "org-real",
  userId: "user-1",
  model: "gpt-oss-120b",
  affiliateCode: "AFF123",
  ...over,
});

describe("shouldCreditAffiliateEarnings (#10853)", () => {
  test("anonymous request (isAnonymous:true) → do NOT credit affiliate earnings", () => {
    expect(shouldCreditAffiliateEarnings(ctx({ isAnonymous: true }))).toBe(
      false,
    );
  });

  test("legacy sentinel org 'anonymous' (no explicit flag) → do NOT credit", () => {
    expect(
      shouldCreditAffiliateEarnings(
        ctx({ organizationId: "anonymous", isAnonymous: undefined }),
      ),
    ).toBe(false);
  });

  test("real authed org (isAnonymous unset) → credit as before", () => {
    expect(shouldCreditAffiliateEarnings(ctx({}))).toBe(true);
  });

  test("real authed org (isAnonymous:false) → credit", () => {
    expect(shouldCreditAffiliateEarnings(ctx({ isAnonymous: false }))).toBe(
      true,
    );
  });

  test("both signals anonymous → do NOT credit (defense in depth)", () => {
    expect(
      shouldCreditAffiliateEarnings(
        ctx({ organizationId: "anonymous", isAnonymous: true }),
      ),
    ).toBe(false);
  });
});
