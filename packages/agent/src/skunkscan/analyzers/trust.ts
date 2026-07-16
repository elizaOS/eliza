import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletExposureSummary,
  WalletFundingSummary,
  WalletRiskSummary,
  WalletTrustSummary,
} from "../types";
import {
  buildConfidenceInput,
  confidenceLevelFromScore,
} from "../confidence/framework";

import { createInvestorInsight } from "../explainability/builder";
import { INVESTOR_INSIGHT_TEMPLATES } from "../explainability/templates";
import { InvestorEvidenceCollection } from "../explainability/evidenceCollection";

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
    limitations.push(
      "Wallet age could not be confidently determined.",
    );
  }

  if (activity.activityLevel === "high") {
    trustScore += 20;
    positiveSignals.push(
      "Wallet has consistent recent activity.",
    );
  } else if (activity.activityLevel === "medium") {
    trustScore += 15;
    positiveSignals.push(
      "Wallet has moderate recent activity.",
    );
  } else if (activity.activityLevel === "low") {
    trustScore += 8;
    positiveSignals.push(
      "Wallet has some recent activity.",
    );
  } else {
    limitations.push(
      "No recent activity was found in the analyzed sample.",
    );
  }

  if (funding.fundingSourceType === "exchange") {
    trustScore += 20;
    positiveSignals.push(
      "Wallet appears to have exchange-linked funding.",
    );
  } else if (funding.fundingSourceType === "wallet") {
    trustScore += 10;
    positiveSignals.push(
      "Wallet has an identifiable funding wallet.",
    );
  } else {
    limitations.push("Funding source is unknown.");
  }

  if (exposure.exposureLevel === "none") {
    trustScore += 20;
    positiveSignals.push(
      "No known exposure was identified.",
    );
  } else if (exposure.exposureLevel === "low") {
    trustScore += 8;
    limitations.push(
      "Low exposure indicators were identified.",
    );
  } else {
    limitations.push(
      "Known exposure indicators reduce trust.",
    );
  }

  if (risk.level === "low") {
    trustScore += 10;
    positiveSignals.push(
      "Current risk level is low.",
    );
  } else if (risk.level === "medium") {
    limitations.push(
      "Medium risk level limits trust.",
    );
  } else {
    limitations.push(
      "High risk level significantly limits trust.",
    );
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

  const confidenceInput = buildConfidenceInput([
    {
      condition: positiveSignals.length >= 5,
      score: 40,
      reason: "Several positive trust indicators were identified.",
    },
    {
      condition: limitations.length <= 2,
      score: 30,
      reason: "Few evidence limitations were identified.",
    },
    {
      condition: trustScore >= 70,
      score: 30,
      reason: "Overall trust score is strong.",
    },
  ]);

  const evidenceConfidence =
    confidenceLevelFromScore(confidenceInput.score);

  const confidence =
    evidenceConfidence;

  const investorInsights: InvestorEvidenceCollection = {
  positive: [],
  neutral: [],
  negative: [],
};

if (
  age.classification === "veteran" ||
  age.classification === "established"
) {
  investorInsights.positive.push(
    createInvestorInsight({
      id: "established-wallet-history",

      title:
        INVESTOR_INSIGHT_TEMPLATES
          .establishedWalletHistory.title,

      finding:
        age.classification === "veteran"
          ? "The wallet has a long blockchain history."
          : "The wallet has an established blockchain history.",

      whyItMatters:
        INVESTOR_INSIGHT_TEMPLATES
          .establishedWalletHistory
          .whyItMatters,

      impact: "positive",

      confidence: "high",

      severity: "medium",

      evidenceRecordIds: [],

      limitations: [],
    }),
  );
}

if (exposure.exposureLevel === "none") {
  investorInsights.positive.push(
    createInvestorInsight({
      id: "no-known-exposure",

      title:
        INVESTOR_INSIGHT_TEMPLATES
          .noKnownExposure.title,

      finding:
        "No known scam, rug-pull, sanctioned, adverse-media, or suspicious exposure was identified in the currently connected intelligence sources.",

      whyItMatters:
        INVESTOR_INSIGHT_TEMPLATES
          .noKnownExposure
          .whyItMatters,

      impact: "positive",

      confidence:
        exposure.evidenceConfidence,

      severity: "high",

      evidenceRecordIds: [
        "exposure-summary",
      ],

      limitations: [
        "This finding is limited to the exposure sources currently connected to SkunkScanAI.",
      ],
    }),
  );
}

  return {
    trustScore,

    trustLevel,

    evidenceConfidence,

    confidenceAnalysis: confidenceInput,

    confidence,

    positiveSignals,

    limitations,

   investorExplanation: {
  summary: buildInvestorSummary(
    trustLevel,
  ),

  whyThisAssessment:
    buildPositiveExplanation(
      positiveSignals,
    ),

  whatReducedConfidence:
    buildLimitationExplanation(
      limitations,
    ),
},

investorInsights,
};
}

function buildInvestorSummary(
  trustLevel: WalletTrustSummary["trustLevel"],
): string {
  switch (trustLevel) {
    case "very_high":
      return "This wallet demonstrates consistently strong trust indicators. The available blockchain evidence supports a very high level of trust, with only minimal evidence limitations identified.";

    case "high":
      return "This wallet demonstrates mostly positive trust indicators. The available evidence supports a high level of trust, although some information could not be fully verified.";

    case "medium":
      return "This wallet shows more positive than negative trust indicators. While the available blockchain evidence is generally reassuring, some missing or limited information prevents a higher trust assessment.";

    case "low":
      return "This wallet currently shows limited positive trust indicators. The available evidence contains several uncertainties or concerns that reduce the overall trust assessment.";

    case "very_low":
    default:
      return "This wallet currently demonstrates very limited trust indicators. Based on the available blockchain evidence, significant uncertainties or negative indicators reduce confidence in the overall trust assessment.";
  }
}

function buildPositiveExplanation(
  signals: string[],
): string[] {
  return signals.map((signal) => {
    switch (signal) {
      case "Wallet has a long history.":
        return "The wallet has existed long enough to establish a meaningful blockchain history.";

      case "Wallet is established.":
        return "The wallet has been active for a sufficient period to provide meaningful historical evidence.";

      case "Wallet has consistent recent activity.":
        return "The wallet has shown consistent blockchain activity during the analyzed period.";

      case "Wallet has moderate recent activity.":
        return "The wallet demonstrates ongoing blockchain activity without appearing inactive.";

      case "Wallet has some recent activity.":
        return "Recent blockchain activity confirms that the wallet remains active.";

      case "Wallet appears to have exchange-linked funding.":
        return "Funding patterns indicate a likely connection with a centralized exchange.";

      case "Wallet has an identifiable funding wallet.":
        return "The origin of funding could be partially identified through blockchain analysis.";

      case "No known exposure was identified.":
        return "No known scam, rug-pull or suspicious exposure was identified in the connected intelligence sources.";

      case "Current risk level is low.":
        return "The calculated wallet risk remains low based on the currently available evidence.";

      default:
        return signal;
    }
  });
}

function buildLimitationExplanation(
  limitations: string[],
): string[] {
  return limitations.map((limitation) => {
    switch (limitation) {
      case "Funding source is unknown.":
        return "The original funding source could not be confidently identified.";

      case "Wallet age could not be confidently determined.":
        return "The available blockchain history was insufficient to confidently determine wallet age.";

      case "Known exposure indicators reduce trust.":
        return "Known exposure indicators reduce confidence in the overall trust assessment.";

      case "Low exposure indicators were identified.":
        return "Some exposure indicators were identified, although they are currently assessed as low impact.";

      case "Medium risk level limits trust.":
        return "The calculated wallet risk prevents a higher trust assessment.";

      case "High risk level significantly limits trust.":
        return "High-risk indicators significantly reduce the overall trust assessment.";

      default:
        return limitation;
    }
  });
}
