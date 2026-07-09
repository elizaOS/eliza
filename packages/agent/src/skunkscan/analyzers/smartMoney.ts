import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletDeFiSummary,
  WalletPortfolioSummary,
  WalletSmartMoneySummary,
  WalletTrustSummary,
  WalletWhaleSummary,
} from "../types";

export function analyzeWalletSmartMoney(
  age: WalletAgeSummary,
  activity: WalletActivitySummary,
  defi: WalletDeFiSummary,
  portfolio: WalletPortfolioSummary,
  whale: WalletWhaleSummary,
  trust: WalletTrustSummary,
): WalletSmartMoneySummary {
  const positiveSignals: string[] = [];
  const limitations: string[] = [];
  let smartMoneyScore = 0;

  if (age.classification === "veteran") {
    smartMoneyScore += 20;
    positiveSignals.push("Wallet has a long activity history.");
  } else if (age.classification === "established") {
    smartMoneyScore += 12;
    positiveSignals.push("Wallet is established.");
  } else {
    limitations.push("Wallet does not yet show a long-term history.");
  }

  if (activity.activityLevel === "high") {
    smartMoneyScore += 20;
    positiveSignals.push("Wallet shows high recent activity.");
  } else if (activity.activityLevel === "medium") {
    smartMoneyScore += 12;
    positiveSignals.push("Wallet shows moderate recent activity.");
  } else {
    limitations.push("Limited recent activity reduces smart money confidence.");
  }

  if (
    defi.profile === "active_defi_user" ||
    defi.profile === "power_user"
  ) {
    smartMoneyScore += 20;
    positiveSignals.push("Wallet uses recognized DeFi protocols.");
  } else {
    limitations.push("Limited recognized DeFi activity was detected.");
  }

  if (portfolio.diversityLevel === "high") {
    smartMoneyScore += 15;
    positiveSignals.push("Wallet has high portfolio diversity.");
  } else if (portfolio.diversityLevel === "medium") {
    smartMoneyScore += 10;
    positiveSignals.push("Wallet has medium portfolio diversity.");
  } else {
    limitations.push("Portfolio diversity is limited.");
  }

  if (whale.isWhale) {
    smartMoneyScore += 15;
    positiveSignals.push("Wallet has whale-level characteristics.");
  }

  if (trust.trustLevel === "high" || trust.trustLevel === "very_high") {
    smartMoneyScore += 10;
    positiveSignals.push("Wallet has strong trust signals.");
  } else if (trust.trustLevel === "medium") {
    smartMoneyScore += 5;
    positiveSignals.push("Wallet has moderate trust signals.");
  } else {
    limitations.push("Trust signals are limited.");
  }

  smartMoneyScore = Math.max(0, Math.min(100, smartMoneyScore));

  const level =
    smartMoneyScore >= 75
      ? "high"
      : smartMoneyScore >= 50
        ? "medium"
        : smartMoneyScore >= 25
          ? "low"
          : "none";

  const profile =
    whale.isWhale
      ? "whale_participant"
      : defi.profile === "active_defi_user" || defi.profile === "power_user"
        ? "active_defi_participant"
        : activity.activityLevel === "high"
          ? "professional_trader"
          : age.classification === "veteran"
            ? "long_term_investor"
            : "unknown";

  const confidence =
    positiveSignals.length >= 4
      ? "high"
      : positiveSignals.length >= 2
        ? "medium"
        : "low";

  return {
    isSmartMoneyCandidate: level === "medium" || level === "high",
    smartMoneyScore,
    displayScore: `${(smartMoneyScore / 10).toFixed(1)} / 10`,
    level,
    confidence,
    profile,
    positiveSignals,
    limitations,
  };
}
