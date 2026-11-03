import { describe, expect, it } from "vitest";
import {
  adsOn,
  canAddWatch,
  canScore,
  comparisonRows,
  interstitialOnOpen,
  paywallCopy,
  playTrialOffer,
  storeKitTrialOffer,
  TRIAL_DAYS,
  tierFor,
} from "../src/plan.ts";

describe("Free and Pro plans", () => {
  it("gives a 15 day trial and then returns to free", () => {
    const start = Date.parse("2026-11-01T00:00:00Z");
    expect(TRIAL_DAYS).toBe(15);
    expect(playTrialOffer().billingPeriod).toBe("P15D");
    expect(playTrialOffer().offerId).toBe("trial-15");
    expect(storeKitTrialOffer().numberOfPeriods).toBe(15);
    expect(storeKitTrialOffer().paymentMode).toBe("freeTrial");
    expect(tierFor({ pro: false, trialStartedAt: start, now: start + 14 * 86400000 })).toBe(
      "trial"
    );
    expect(tierFor({ pro: false, trialStartedAt: start, now: start + 16 * 86400000 })).toBe("free");
    expect(tierFor({ pro: true, trialStartedAt: null, now: start })).toBe("pro");
  });

  it("keeps ads off Pro, off connect, and off settings", () => {
    expect(adsOn("pro", "status")).toBe(false);
    expect(adsOn("trial", "status")).toBe(false);
    expect(adsOn("free", "connect")).toBe(false);
    expect(adsOn("free", "settings")).toBe(false);
    expect(adsOn("free", "status")).toBe(true);
    expect(interstitialOnOpen()).toBe(false);
  });

  it("limits the free watchlist and the daily Brain score", () => {
    expect(canAddWatch(3, "free")).toBe(false);
    expect(canAddWatch(3, "pro")).toBe(true);
    expect(canScore(1, 0, "free")).toBe(false);
    expect(canScore(1, 1, "free")).toBe(true);
    expect(canScore(9, 0, "pro")).toBe(true);
  });

  it("does not promise profit in the paywall or the table", () => {
    const copy = paywallCopy();
    expect(copy).toContain("15 day free Pro trial");
    expect(copy).toContain("coming soon");
    expect(copy).not.toContain("$19/month");
    expect(copy.toLowerCase()).not.toContain("guaranteed");
    expect(comparisonRows().some((row) => row.feature === "Ads" && row.pro === "None")).toBe(true);
  });
});
