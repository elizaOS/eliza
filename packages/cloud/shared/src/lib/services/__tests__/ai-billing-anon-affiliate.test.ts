/**
 * Guard test for #10853 — anonymous free-tier chat must NOT mint affiliate
 * earnings.
 *
 * billUsage applied the affiliate markup + credited the affiliate owner
 * (redeemableEarningsService.addEarnings, cashable) whenever an active
 * affiliateCode was present — with no check that the request was actually
 * billed. On the anonymous free-tier path (organizationId "anonymous", a no-op
 * reservation) the user pays $0, so an org owner could farm their own affiliate
 * code via free anon requests, minting redeemable_earnings out of nothing.
 *
 * These tests drive the REAL billUsage. Only the pure downstream boundaries are
 * stubbed (pricing math + the affiliate lookup + the earnings/usage/generation
 * side-effect writers); the affiliate GUARD under test runs for real, so each
 * test fails if the guard regresses.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import * as realPricing from "../../pricing";

// Deterministic cost so the affiliate math is predictable (no pricing catalog).
mock.module("../../pricing", () => ({
  ...realPricing,
  calculateCost: mock(async () => ({ inputCost: 0.1, outputCost: 0.2, totalCost: 0.3 })),
}));

// Active affiliate code (10% markup) owned by AFFILIATE_USER.
const AFFILIATE_USER = "00000000-0000-4000-8000-00000000aff1";
mock.module("../../../db/repositories/affiliates", () => ({
  affiliatesRepository: {
    getAffiliateCodeByCode: mock(async () => ({
      id: "aff-code-1",
      user_id: AFFILIATE_USER,
      markup_percent: "10",
      is_active: true,
    })),
  },
}));

// Spy the cashable-earnings write — the thing that must NOT fire for anon.
const addEarnings = mock(async () => ({ ledgerId: "l1" }));
mock.module("../redeemable-earnings", () => ({
  redeemableEarningsService: { addEarnings },
}));

// Side-effect writers billUsage calls — stub so the test needs no DB rows.
mock.module("../usage", () => ({
  usageService: { recordUsage: mock(async () => undefined), record: mock(async () => undefined) },
}));
mock.module("../generations", () => ({
  generationsService: { record: mock(async () => undefined), create: mock(async () => undefined) },
}));

const { billUsage } = await import("../ai-billing");

const USAGE = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
const BASE = {
  userId: "00000000-0000-4000-8000-00000000user",
  model: "openai/gpt-oss-120b",
  provider: "openai",
  affiliateCode: "PARTNER10",
};

beforeEach(() => {
  addEarnings.mockClear();
});

describe("billUsage affiliate earnings guard (#10853)", () => {
  test("anonymous request with an affiliate code mints NO affiliate earnings", async () => {
    const result = await billUsage({ ...BASE, organizationId: "anonymous" }, USAGE);

    // The load-bearing assertion: no cashable earnings created for a $0 request.
    expect(addEarnings).not.toHaveBeenCalled();
    // And the affiliate markup was not layered onto the (uncollected) cost.
    expect(result.totalCost).toBeCloseTo(0.3, 6);
  });

  test("a real paying org with the same affiliate code STILL credits the affiliate (regression)", async () => {
    const result = await billUsage(
      { ...BASE, organizationId: "00000000-0000-4000-8000-0000000000org" },
      USAGE,
    );

    expect(addEarnings).toHaveBeenCalledTimes(1);
    const arg = addEarnings.mock.calls[0][0] as {
      userId: string;
      amount: number;
      source: string;
    };
    expect(arg.userId).toBe(AFFILIATE_USER);
    expect(arg.source).toBe("affiliate");
    expect(arg.amount).toBeCloseTo(0.3 * 0.1, 6); // 10% of the $0.30 cost
    // Affiliate markup was layered onto the charged cost for the paying org.
    expect(result.totalCost).toBeCloseTo(0.3 + 0.03, 6);
  });

  test("paying org affiliate earnings use deterministic request sourceId for dedupe", async () => {
    await billUsage(
      {
        ...BASE,
        organizationId: "00000000-0000-4000-8000-0000000000org",
        requestId: "req-affiliate-1",
      },
      USAGE,
    );
    await billUsage(
      {
        ...BASE,
        organizationId: "00000000-0000-4000-8000-0000000000org",
        requestId: "req-affiliate-1",
      },
      USAGE,
    );

    expect(addEarnings).toHaveBeenCalledTimes(2);
    const first = addEarnings.mock.calls[0][0] as {
      sourceId: string;
      dedupeBySourceId: boolean;
    };
    const second = addEarnings.mock.calls[1][0] as {
      sourceId: string;
      dedupeBySourceId: boolean;
    };
    expect(first.sourceId).toBe("ai_billing:usage:req-affiliate-1");
    expect(second.sourceId).toBe(first.sourceId);
    expect(first.dedupeBySourceId).toBe(true);
    expect(second.dedupeBySourceId).toBe(true);
  });
});
