import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletExposureSummary,
  WalletFundingSummary,
  WalletRiskSummary,
  WalletTrustSummary,
} from "../types";

export function analyzeWalletTrust(
  age: WalletAgeSummary,
  activity: WalletActivitySummary,
  funding: WalletFundingSummary,
  exposure: WalletExposureSummary,
  risk: WalletRiskSummary,
): WalletTrustSummary {
  const positiveSignals: string[] = [];
  const limitations: string[] = [];
  let trustScore = 0;

  if (age.classification === "veteran") {
    trustScore += 30;
    positiveSignals.push("Wallet has a long history.");
  } else if (age.classification === "established") {
    trustScore += 20;
    positiveSignals.push("Wallet is established.");
  } else if (age.classification === "new") {
    trustScore += 5;
    limitations.push("Wallet is relatively new.");
  } else {
    limitations.push("Wallet age could not be confidently determined.");
  }

  if (activity.activityLevel === "high") {
    trustScore += 20;
    positiveSignals.push("Wallet has consistent recent activity.");
  } else if (activity.activityLevel === "medium") {
    trustScore += 15;
    positiveSignals.push("Wallet has moderate recent activity.");
  } else if (activity.activityLevel === "low") {
    trustScore += 8;
    positiveSignals.push("Wallet has some recent activity.");
  } else {
    limitations.push("No recent activity was found in the analyzed sample.");
  }

  if (funding.fundingSourceType === "exchange") {
    trustScore += 20;
    positiveSignals.push("Wallet appears to have exchange-linked funding.");
  } else if (funding.fundingSourceType === "wallet") {
    trustScore += 10;
    positiveSignals.push("Wallet has an identifiable funding wallet.");
  } else {
    limitations.push("Funding source is unknown.");
  }

  if (exposure.exposureLevel === "none") {
    trustScore += 20;
    positiveSignals.push("No known exposure was identified.");
  } else if (exposure.exposureLevel === "low") {
    trustScore += 8;
    limitations.push("Low exposure indicators were identified.");
  } else {
    limitations.push("Known exposure indicators reduce trust.");
  }

  if (risk.level === "low") {
    trustScore += 10;
    positiveSignals.push("Current risk level is low.");
  } else if (risk.level === "medium") {
    limitations.push("Medium risk level limits trust.");
  } else {
    limitations.push("High risk level significantly limits trust.");
  }

  trustScore = Math.max(0, Math.min(100, trustScore));

  const trustLevel =
    trustScore >= 85
      ? "very_high"
      : trustScore >= 70
        ? "high"
        : trustScore >= 45
          ? "medium"
          : trustScore >= 20
            ? "low"
            : "very_low";

  const confidence =
    limitations.length === 0
      ? "high"
      : positiveSignals.length >= limitations.length
        ? "medium"
        : "low";

  return {
    trustScore,
    trustLevel,
    confidence,
    positiveSignals,
    limitations,
  };
}
