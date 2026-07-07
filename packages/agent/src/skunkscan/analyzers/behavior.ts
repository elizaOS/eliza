import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletBehaviorSummary,
  WalletDeFiSummary,
  WalletRiskSummary,
  WalletWhaleSummary,
} from "../types";

export function analyzeWalletBehavior(
  activity: WalletActivitySummary,
  age: WalletAgeSummary,
  defi: WalletDeFiSummary,
  whale: WalletWhaleSummary,
  risk: WalletRiskSummary,
): WalletBehaviorSummary {
  let primaryProfile: WalletBehaviorSummary["primaryProfile"] = "unknown";
  let confidence: WalletBehaviorSummary["confidence"] = "low";
  const traits: string[] = [];

  if (whale.isWhale) {
    primaryProfile = "whale";
    confidence = "high";
    traits.push("Large portfolio detected.");
  } else if (risk.level === "high") {
    primaryProfile = "high_risk_wallet";
    confidence = "high";
    traits.push("Elevated risk indicators detected.");
  } else if (
    defi.profile === "active_defi_user" ||
    defi.profile === "power_user"
  ) {
    primaryProfile = "defi_user";
    confidence = "high";
    traits.push("Active DeFi protocol usage.");
  } else if (activity.activityLevel === "high") {
    primaryProfile = "active_trader";
    confidence = "medium";
    traits.push("High recent transaction activity.");
  } else if (age.classification === "new") {
    primaryProfile = "new_wallet";
    confidence = "medium";
    traits.push("Recently created wallet.");
  } else {
    primaryProfile = "holder";
    confidence = "medium";
    traits.push("Appears to be primarily holding assets.");
  }

  if (age.classification === "veteran") {
    traits.push("Long wallet history.");
  }

  if (risk.level === "low") {
    traits.push("Low current risk.");
  }

  return {
    primaryProfile,
    confidence,
    traits,
    explanation: buildExplanation(primaryProfile),
  };
}

function buildExplanation(
  profile: WalletBehaviorSummary["primaryProfile"],
): string {
  switch (profile) {
    case "whale":
      return "This wallet appears to control a significant portfolio.";

    case "active_trader":
      return "This wallet appears to trade frequently.";

    case "defi_user":
      return "This wallet actively interacts with DeFi protocols.";

    case "holder":
      return "This wallet primarily appears to hold digital assets.";

    case "new_wallet":
      return "This wallet has only recently become active.";

    case "high_risk_wallet":
      return "This wallet shows elevated risk indicators.";

    default:
      return "Insufficient information is available to classify this wallet.";
  }
}
