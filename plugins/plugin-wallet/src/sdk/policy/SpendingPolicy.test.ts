/**
 * Regression suite for SpendingPolicy's RollingSpendCap interaction with the
 * DraftThenApprove path. Exercises the real exported class (no mocks): a
 * payment at/above draftThreshold takes the draft branch and therefore never
 * hits the auto-approval spend recording, so approveDraft() must accrue the
 * approved amount into the rolling window exactly once. Without that, the
 * largest payments — the ones the cap exists to govern — escaped the cap
 * accounting entirely (fail-open guardrail hole, issue #29565).
 */

import { describe, expect, it } from "vitest";
import { SpendingPolicy } from "./SpendingPolicy.ts";

describe("SpendingPolicy — approved drafts and RollingSpendCap (#29565)", () => {
  it("records an approved draft into the rolling window so a later payment over the cap is rejected", async () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
      draftThreshold: 400,
    });

    const drafted = await policy.check({ merchant: "m", amount: 400 });
    expect(drafted.status).toBe("draft");
    expect(drafted.draftId).toBeDefined();

    expect(policy.approveDraft(drafted.draftId as string)).toBe(true);

    // 700 alone fits under the 1000 cap, but 400 was already approved, so the
    // cumulative 1100 must trip the cap. Pre-fix this returned "draft"/allowed
    // because the approved draft contributed 0 to the window.
    const next = await policy.check({ merchant: "m", amount: 700 });
    expect(next.status).toBe("rejected");
    expect(next.reason).toMatch(/spend cap exceeded/i);
  });

  it("regression: N drafted+approved payments over the cap block the next payment (repro: 5000 approved vs cap 1000)", async () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
      draftThreshold: 100,
    });

    let approvedTotal = 0;
    for (let i = 0; i < 50; i++) {
      const r = await policy.check({ merchant: "m", amount: 100 });
      if (r.status === "draft" && r.draftId) {
        policy.approveDraft(r.draftId);
        approvedTotal += 100;
      }
    }

    // With drafts counted, cumulative approval halts once it reaches the cap
    // instead of climbing to the pre-fix 5000.
    expect(approvedTotal).toBe(1000);

    // A fresh below-threshold payment must now be rejected rather than
    // auto-approved as if nothing had been spent.
    const small = await policy.check({ merchant: "m", amount: 50 });
    expect(small.status).toBe("rejected");

    const large = await policy.check({ merchant: "m", amount: 1000 });
    expect(large.status).toBe("rejected");
  });

  it("records spend only once when approveDraft is called repeatedly for the same draft", async () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
      draftThreshold: 600,
    });

    const drafted = await policy.check({ merchant: "m", amount: 600 });
    expect(drafted.status).toBe("draft");
    const draftId = drafted.draftId as string;

    expect(policy.approveDraft(draftId)).toBe(true);
    expect(policy.approveDraft(draftId)).toBe(true);

    // Only 600 should be accrued. A subsequent 400 (below threshold, auto path)
    // brings cumulative to exactly 1000 and is approved. Double-counting would
    // have accrued 1200 and rejected this.
    const fits = await policy.check({ merchant: "m", amount: 400 });
    expect(fits.status).toBe("approved");

    // But a fresh unit now pushes over the cap.
    const over = await policy.check({ merchant: "m", amount: 1 });
    expect(over.status).toBe("rejected");
  });

  it("rejectDraft never records spend, and a subsequently approved draft still fits", async () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
      draftThreshold: 500,
    });

    const first = await policy.check({ merchant: "m", amount: 900 });
    expect(first.status).toBe("draft");
    expect(policy.rejectDraft(first.draftId as string)).toBe(true);

    // The rejected 900 must contribute nothing; a fresh 900 draft can be
    // approved and fits within the 1000 cap.
    const second = await policy.check({ merchant: "m", amount: 900 });
    expect(second.status).toBe("draft");
    expect(policy.approveDraft(second.draftId as string)).toBe(true);

    // Now 900 is accrued; a further 200 exceeds the cap.
    const over = await policy.check({ merchant: "m", amount: 200 });
    expect(over.status).toBe("rejected");
  });

  it("approving an already-rejected draft is a no-op that records nothing", async () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
      draftThreshold: 500,
    });

    const drafted = await policy.check({ merchant: "m", amount: 800 });
    const draftId = drafted.draftId as string;
    expect(policy.rejectDraft(draftId)).toBe(true);
    // Cannot resurrect a rejected draft; nothing is accrued.
    expect(policy.approveDraft(draftId)).toBe(false);

    const fresh = await policy.check({ merchant: "m", amount: 900 });
    expect(fresh.status).toBe("draft");
  });

  it("approving a draft when rollingCap is undefined is a no-op and does not throw", async () => {
    const policy = new SpendingPolicy({ draftThreshold: 100 });

    const drafted = await policy.check({ merchant: "m", amount: 500 });
    expect(drafted.status).toBe("draft");

    expect(() => policy.approveDraft(drafted.draftId as string)).not.toThrow();
    expect(policy.approveDraft(drafted.draftId as string)).toBe(true);
  });

  it("returns false when approving a draftId that does not exist", () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
      draftThreshold: 100,
    });
    expect(policy.approveDraft("draft-does-not-exist")).toBe(false);
  });
});
