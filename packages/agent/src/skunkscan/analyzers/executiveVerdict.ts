import {
  WalletBehaviorSummary,
  WalletCaseSummary,
  WalletDisplaySummary,
  WalletEvidenceItem,
  WalletExecutiveVerdict,
  WalletExposureSummary,
  WalletRiskSummary,
  WalletTrustSummary,
} from "../types";

export function analyzeExecutiveVerdict(
  display: WalletDisplaySummary,
  behavior: WalletBehaviorSummary,
  caseSummary: WalletCaseSummary,
  evidence: WalletEvidenceItem[],
  exposure: WalletExposureSummary,
  risk: WalletRiskSummary,
  trust: WalletTrustSummary,
): WalletExecutiveVerdict {
  const verdict = determineVerdict(risk, exposure, caseSummary);
  const why = evidence
    .filter((item) =>
      item.severity === "high" ||
      item.severity === "medium" ||
      item.category === "age" ||
      item.category === "exposure" ||
      item.category === "risk" ||
      item.category === "behavior",
    )
    .slice(0, 5)
    .map((item) => item.description);

  return {
    verdict,
    headline: buildHeadline(verdict),
    riskDisplay: display.risk.displayScore,
    trustDisplay: display.trust.displayScore,
    exposureDisplay: display.exposure.displayScore,
    profile: behavior.primaryProfile.replace(/_/g, " "),
    recommendation: caseSummary.recommendation,
    confidence: trust.confidence,
    why,
    suggestedAction: buildSuggestedAction(caseSummary.recommendation),
  };
}

function determineVerdict(
  risk: WalletRiskSummary,
  exposure: WalletExposureSummary,
  caseSummary: WalletCaseSummary,
): WalletExecutiveVerdict["verdict"] {
  if (risk.level === "high" || exposure.exposureLevel === "high") {
    return "high_risk";
  }

  if (caseSummary.recommendation === "investigate") {
    return "investigate";
  }

  if (
    caseSummary.recommendation === "review" ||
    exposure.exposureLevel === "medium"
  ) {
    return "review";
  }

  return "low_risk";
}

function buildHeadline(
  verdict: WalletExecutiveVerdict["verdict"],
): string {
  switch (verdict) {
    case "high_risk":
      return "High risk wallet";

    case "investigate":
      return "Further investigation recommended";

    case "review":
      return "Manual review recommended";

    case "low_risk":
      return "Low risk wallet";

    default:
      return "Wallet investigation completed";
  }
}

function buildSuggestedAction(
  recommendation: WalletCaseSummary["recommendation"],
): string {
  switch (recommendation) {
    case "allow":
      return "Proceed normally based on the current investigation.";

    case "review":
      return "Perform manual review before proceeding.";

    case "investigate":
      return "Perform additional investigation before proceeding.";

    case "high_risk":
      return "Do not automatically proceed. Escalate according to your organization's policy.";

    default:
      return "Review the investigation details before proceeding.";
  }
}
