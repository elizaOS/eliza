import { readFileSync } from "node:fs";

/** Free is ad-supported and limited. Pro removes ads and lifts the limits. */

export type Tier = "free" | "trial" | "pro";

export interface PlanPrices {
  monthly: string;
  launchMonthly: string;
  launchSlots: number;
  yearly: string;
}

export const PLAN_PRICES: PlanPrices = {
  monthly: "$19/month",
  launchMonthly: "$9.99/mo launch price",
  launchSlots: 100,
  yearly: "$149/year",
};

export const FREE_WALLET_LIMIT = 1;
export const FREE_WATCHLIST_LIMIT = 3;
export const FREE_BRAIN_SCORES_PER_DAY = 1;
export const FREE_ALERT_DELAY_MS = 60_000;

export function loadTrialDays(file = new URL("../product.config.json", import.meta.url)): number {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { TRIAL_DAYS?: number };
    const days = Number(parsed.TRIAL_DAYS);
    if (Number.isFinite(days) && days > 0) return days;
  } catch {
    // Use the default when the config file is missing.
  }
  return 15;
}

export const TRIAL_DAYS = loadTrialDays();
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

/** Play Console free-trial offer. The period follows TRIAL_DAYS. */
export function playTrialOffer(days = TRIAL_DAYS) {
  return {
    productId: "valhalla_pro_monthly",
    basePlanId: "monthly",
    offerId: `trial-${days}`,
    pricingPhase: "free",
    billingPeriod: `P${days}D`,
  };
}

/** App Store Connect introductory offer. The length follows TRIAL_DAYS. */
export function storeKitTrialOffer(days = TRIAL_DAYS) {
  return {
    productId: "valhalla_pro_monthly",
    paymentMode: "freeTrial" as const,
    periodUnit: "day" as const,
    numberOfPeriods: days,
  };
}

export interface PlanInput {
  pro: boolean;
  trialStartedAt: number | null;
  now: number;
}

export function tierFor(input: PlanInput): Tier {
  if (input.pro) return "pro";
  if (input.trialStartedAt != null && input.now - input.trialStartedAt < TRIAL_MS) return "trial";
  return "free";
}

export function adsOn(tier: Tier, screen: "status" | "connect" | "settings" | "other"): boolean {
  if (tier !== "free") return false;
  if (screen === "connect" || screen === "settings") return false;
  return screen === "status" || screen === "other";
}

/** Interstitials never run when the app opens. */
export function interstitialOnOpen(): boolean {
  return false;
}

export function canAddWallet(current: number, tier: Tier): boolean {
  if (tier !== "free") return true;
  return current < FREE_WALLET_LIMIT;
}

export function canAddWatch(current: number, tier: Tier): boolean {
  if (tier !== "free") return true;
  return current < FREE_WATCHLIST_LIMIT;
}

export function canScore(usedToday: number, extraFromAds: number, tier: Tier): boolean {
  if (tier !== "free") return true;
  return usedToday < FREE_BRAIN_SCORES_PER_DAY + extraFromAds;
}

export function alertDelayMs(tier: Tier): number {
  return tier === "free" ? FREE_ALERT_DELAY_MS : 0;
}

export function paywallCopy(prices: PlanPrices = PLAN_PRICES): string {
  return `Free includes ads, 1 wallet, 3 watchlist coins, and 1 Brain score a day. A ${TRIAL_DAYS} day free Pro trial is included. Pro is ${prices.launchMonthly}. Yearly and Lifetime are coming soon. Pro has no ads. This is not a promise of profit.`;
}

export function comparisonRows(): Array<{ feature: string; free: string; pro: string }> {
  return [
    { feature: "Wallets", free: "1", pro: "Unlimited" },
    { feature: "Live balances and P&L", free: "Yes", pro: "Yes" },
    { feature: "Alerts", free: "Basic, delayed", pro: "Instant Telegram and push" },
    { feature: "Watchlist", free: "3 coins", pro: "Unlimited" },
    { feature: "Brain scores", free: `1 a day, plus a ${TRIAL_DAYS} day trial`, pro: "Unlimited" },
    { feature: "Ads", free: "Banner and optional rewarded", pro: "None" },
    { feature: "P&L history", free: "Today", pro: "Full history and CSV" },
    { feature: "Desktop layouts", free: "Single", pro: "Multi-chart" },
    { feature: "Support", free: "Standard", pro: "Priority" },
  ];
}
