import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletBehaviorSummary,
  WalletDeFiSummary,
  WalletEvidenceItem,
  WalletFundingSummary,
  WalletPortfolioSummary,
  WalletRiskSummary,
  WalletWhaleSummary,
} from "../types";

export function analyzeWalletEvidence(
  activity: WalletActivitySummary,
  age: WalletAgeSummary,
  funding: WalletFundingSummary,
  portfolio: WalletPortfolioSummary,
  defi: WalletDeFiSummary,
  risk: WalletRiskSummary,
  whale: WalletWhaleSummary,
  behavior: WalletBehaviorSummary,
): WalletEvidenceItem[] {
  const evidence: WalletEvidenceItem[] = [];

  evidence.push({
    id: "wallet-activity",
    category: "activity",
    severity: activity.activityLevel === "high" ? "medium" : "info",
    title: "Recent activity detected",
    description: `Wallet has ${activity.recentTransactionCount} recent transaction(s) in the analyzed sample.`,
  });

  evidence.push({
    id: "wallet-age",
    category: "age",
    severity: age.classification === "new" ? "medium" : "info",
    title: "Wallet age classification",
    description: `Wallet age is classified as ${age.classification}.`,
  });

  evidence.push({
    id: "funding-source",
    category: "funding",
    severity: funding.fundingSourceType === "unknown" ? "low" : "info",
    title: "Funding source assessment",
    description: `Funding source type is ${funding.fundingSourceType}.`,
  });

  evidence.push({
    id: "portfolio-overview",
    category: "portfolio",
    severity: portfolio.concentrationLevel === "high" ? "medium" : "info",
    title: "Portfolio overview",
    description: `Wallet holds ${portfolio.tokenCount} token(s) with ${portfolio.diversityLevel} portfolio diversity.`,
  });

  evidence.push({
    id: "defi-usage",
    category: "defi",
    severity: defi.profile === "power_user" ? "medium" : "info",
    title: "DeFi usage profile",
    description: `Wallet DeFi profile is ${defi.profile.replace(/_/g, " ")}.`,
  });

  evidence.push({
    id: "risk-score",
    category: "risk",
    severity:
      risk.level === "high"
        ? "high"
        : risk.level === "medium"
          ? "medium"
          : "low",
    title: "Risk assessment",
    description: `Wallet risk level is ${risk.level} with score ${risk.score}.`,
  });

  evidence.push({
    id: "whale-status",
    category: "whale",
    severity: whale.isWhale ? "medium" : "info",
    title: "Whale status",
    description: `Wallet whale level is ${whale.whaleLevel}.`,
  });

  evidence.push({
    id: "behavior-profile",
    category: "behavior",
    severity:
      behavior.primaryProfile === "high_risk_wallet"
        ? "high"
        : "info",
    title: "Behavior profile",
    description: behavior.explanation,
  });

  return evidence;
}
