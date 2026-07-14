import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletBehaviorSummary,
  WalletDeFiSummary,
  WalletRiskSummary,
  WalletWhaleSummary,
} from "../types";
import {
  createConfidenceResponse,
} from "../confidence/framework";

export function analyzeWalletBehavior(
  activity: WalletActivitySummary,
  age: WalletAgeSummary,
  defi: WalletDeFiSummary,
  whale: WalletWhaleSummary,
  risk: WalletRiskSummary,
): WalletBehaviorSummary {
  let primaryProfile: WalletBehaviorSummary["primaryProfile"] =
    "unknown";

  let confidence: WalletBehaviorSummary["confidence"] =
    "low";

  const traits: string[] = [];
  const limitations: string[] = [];

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
    traits.push(
      "Appears to be primarily holding assets.",
    );
  }

  if (age.classification === "veteran") {
    traits.push("Long wallet history.");
  }

  if (risk.level === "low") {
    traits.push("Low current risk.");
  }

  if (age.classification === "unknown") {
    limitations.push(
      "Wallet age could not be confidently determined.",
    );
  }

  if (activity.activityLevel === "none") {
    limitations.push(
      "No recent activity was identified in the analyzed transaction sample.",
    );
  }

  if (defi.protocolCount === 0) {
    limitations.push(
      "No recognized DeFi protocol interactions were identified in the analyzed sample.",
    );
  }

  if (
    whale.estimatedPortfolioUsdValue === null ||
    whale.estimatedPortfolioUsdValue === undefined
  ) {
    limitations.push(
      "Portfolio USD valuation was unavailable, which limits wallet-size interpretation.",
    );
  }

  const confidenceAnalysis = createConfidenceResponse([
    {
      condition:
        typeof activity.recentTransactionCount === "number",
      score: 20,
      reason:
        "Wallet activity metrics were available.",
    },
    {
      condition: age.classification !== "unknown",
      score: 20,
      reason:
        "Wallet age evidence was available.",
    },
    {
      condition: Boolean(defi.profile),
      score: 15,
      reason:
        "A DeFi usage profile was available.",
    },
    {
      condition:
        whale.evidenceConfidence === "high",
      score: 20,
      reason:
        "Whale evidence confidence is high.",
    },
    {
      condition:
        whale.evidenceConfidence === "medium",
      score: 10,
      reason:
        "Whale evidence confidence is medium.",
    },
    {
      condition: Boolean(risk.level),
      score: 15,
      reason:
        "A wallet risk assessment was available.",
    },
    {
      condition: traits.length >= 2,
      score: 10,
      reason:
        "Multiple behavioral traits were identified.",
    },
  ]);

  if (
    confidenceAnalysis.level === "low"
  ) {
    confidence = "low";
  } else if (
    confidence === "high" &&
    confidenceAnalysis.level !== "high"
  ) {
    confidence = "medium";
  }

  return {
    primaryProfile,

    evidenceConfidence:
      confidenceAnalysis.level,

    confidenceAnalysis,

    confidence,

    traits,

    explanation:
      buildExplanation(primaryProfile),

    limitations,
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
