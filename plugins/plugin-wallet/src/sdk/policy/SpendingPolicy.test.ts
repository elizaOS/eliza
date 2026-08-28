import { describe, expect, it, vi } from "vitest";
import { SpendingPolicy } from "./SpendingPolicy";

const merchant = "0xABC123";
const cap100 = { rollingCap: { maxAmount: 100, windowMs: 86_400_000 } };
const threshold50 = { draftThreshold: 50 };

describe("SpendingPolicy rolling spend cap", () => {
  it("records below-threshold spend immediately and enforces the cap", async () => {
    const policy = new SpendingPolicy({
      ...cap100,
      ...threshold50,
    });
    const first = await policy.check({ merchant, amount: 30 });
    expect(first.status).toBe("approved");
    // 30 already consumed: a second 40 would push cumulative spend to 70 > 50? no,
    // cap is 100 — use a larger second payment to prove the window is populated.
    const second = await policy.check({ merchant, amount: 40 });
    expect(second.status).toBe("approved");
    // 30 + 40 = 70 > cap 100? no. Third payment of 40 exceeds: 70 + 40 = 110 > 100.
    const third = await policy.check({ merchant, amount: 40 });
    expect(third.status).toBe("rejected");
  });

  it("counts an approved draft against the rolling cap (rejects later spend)", async () => {
    const policy = new SpendingPolicy({
      ...cap100,
      ...threshold50,
    });
    const draft = await policy.check({ merchant, amount: 80 });
    expect(draft.status).toBe("draft");
    expect(draft.draftId).toBeDefined();
    expect(policy.approveDraft(draft.draftId as string)).toBe(true);

    // The approved 80 must consume the window: 80 + 30 = 110 > 100.
    const later = await policy.check({ merchant, amount: 30 });
    expect(later.status).toBe("rejected");

    // The approval transition must be visible to audit consumers: an entry
    // reflecting the committed spend (not the original "draft" status) exists
    // for this draft.
    const approval = policy
      .getAuditLog()
      .find((e) => e.draftId === draft.draftId && e.status === "approved");
    expect(approval).toBeDefined();
    expect(approval?.amount).toBe(80);
    expect(approval?.merchant).toBe(merchant);
  });

  it("counts every approved draft, so two large drafts exhaust the cap", async () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 150, windowMs: 86_400_000 },
      ...threshold50,
    });
    const d1 = await policy.check({ merchant, amount: 80 });
    expect(d1.status).toBe("draft");
    expect(policy.approveDraft(d1.draftId as string)).toBe(true);

    const d2 = await policy.check({ merchant, amount: 60 });
    expect(d2.status).toBe("draft");
    expect(policy.approveDraft(d2.draftId as string)).toBe(true);

    // 80 + 60 = 140 already spent: a further payment exceeds the cap.
    const later = await policy.check({ merchant, amount: 20 });
    expect(later.status).toBe("rejected");
  });

  it("approving the same draft twice does not double-count its spend", async () => {
    const policy = new SpendingPolicy({
      rollingCap: { maxAmount: 150, windowMs: 86_400_000 },
      ...threshold50,
    });
    const draft = await policy.check({ merchant, amount: 80 });
    expect(draft.status).toBe("draft");
    expect(policy.approveDraft(draft.draftId as string)).toBe(true);
    expect(policy.approveDraft(draft.draftId as string)).toBe(true);

    // Single count: 80 + 40 = 120 <= 150 -> approved. Double count would reject.
    const later = await policy.check({ merchant, amount: 40 });
    expect(later.status).toBe("approved");
  });

  it("does not consume the cap for a rejected draft", async () => {
    const policy = new SpendingPolicy({
      ...cap100,
      ...threshold50,
    });
    const draft = await policy.check({ merchant, amount: 80 });
    expect(draft.status).toBe("draft");
    expect(policy.rejectDraft(draft.draftId as string)).toBe(true);

    const later = await policy.check({ merchant, amount: 30 });
    expect(later.status).toBe("approved");

    // The rejection transition must be visible to audit consumers too.
    const rejection = policy
      .getAuditLog()
      .find((e) => e.draftId === draft.draftId && e.status === "rejected");
    expect(rejection).toBeDefined();
  });

  it("ages approved-draft spend out of the rolling window like immediate spend", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const policy = new SpendingPolicy({
        ...cap100,
        ...threshold50,
      });
      const draft = await policy.check({ merchant, amount: 80 });
      expect(draft.status).toBe("draft");
      expect(policy.approveDraft(draft.draftId as string)).toBe(true);

      // Two days later the one-day window has fully rolled.
      vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
      const later = await policy.check({ merchant, amount: 30 });
      expect(later.status).toBe("approved");
    } finally {
      vi.useRealTimers();
    }
  });
});
