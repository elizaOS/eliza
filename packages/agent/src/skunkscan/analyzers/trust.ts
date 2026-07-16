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

if (
  activity.activityLevel === "high" ||
  activity.activityLevel === "medium" ||
  activity.activityLevel === "low"
) {
  investorInsights.positive.push(
    createInvestorInsight({
      id: "recent-wallet-activity",

      title: "Recent Wallet Activity",

      finding:
        activity.activityLevel === "high"
          ? "The wallet shows a high level of recent blockchain activity."
          : activity.activityLevel === "medium"
            ? "The wallet shows a moderate level of recent blockchain activity."
            : "The wallet shows some recent blockchain activity.",

      whyItMatters:
        "Recent activity provides current evidence about how the wallet is being used and reduces reliance on historical data alone.",

      impact: "positive",

      confidence: "high",

      severity:
        activity.activityLevel === "high"
          ? "medium"
          : "low",

      evidenceRecordIds: [
        "activity-summary",
      ],

      limitations: [
        "The activity classification is based on the analyzed transaction sample and may not represent the wallet's complete transaction history.",
      ],
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

if (
  exposure.exposureLevel === "medium" ||
  exposure.exposureLevel === "high"
) {
  investorInsights.negative.push(
    createInvestorInsight({
      id: "known-exposure-indicators",

      title: "Known Exposure Indicators",

      finding:
        exposure.exposureLevel === "high"
          ? "High exposure indicators were identified in the currently connected intelligence sources."
          : "Meaningful exposure indicators were identified in the currently connected intelligence sources.",

      whyItMatters:
        "Exposure to known scam, rug-pull, suspicious, sanctioned, or adverse-media addresses can materially affect how the wallet should be understood.",

      impact: "negative",

      confidence:
        exposure.evidenceConfidence,

      severity:
        exposure.exposureLevel === "high"
          ? "critical"
          : "high",

      evidenceRecordIds: [
        "exposure-summary",
      ],

      limitations: [
        "An exposure match does not by itself prove ownership, intent, wrongdoing, or direct participation.",
        "The result is limited to the intelligence sources currently connected to SkunkScanAI.",
      ],
    }),
  );
}
  
if (risk.level === "low") {
  investorInsights.positive.push(
    createInvestorInsight({
      id: "low-risk-indicators",

      title:
        INVESTOR_INSIGHT_TEMPLATES
          .lowRisk.title,

      finding:
        `The wallet currently has a low calculated risk level with an internal score of ${risk.score} out of 100.`,

      whyItMatters:
        INVESTOR_INSIGHT_TEMPLATES
          .lowRisk
          .whyItMatters,

      impact: "positive",

      confidence:
        evidenceConfidence,

      severity: "high",

      evidenceRecordIds: [
        "risk-assessment",
      ],

      limitations: [
        "The risk assessment reflects the evidence and analytical rules available at the time of analysis.",
      ],
    }),
  );
}

  if (funding.fundingSourceType === "unknown") {
  investorInsights.neutral.push(
    createInvestorInsight({
      id: "funding-source-unknown",

      title: "Funding Source Could Not Be Confirmed",

      finding:
        "The wallet's original funding source could not be confidently identified from the available blockchain evidence.",

      whyItMatters:
        "Knowing how a wallet was initially funded can provide useful context about its origin and relationships.",

      impact: "neutral",

      confidence:
        funding.evidenceConfidence,

      severity: "medium",

      evidenceRecordIds: [
        "funding-assessment",
      ],

      limitations: [
        "The first known transaction may not contain the wallet's complete funding history.",
      ],
    }),
  );
}

if (funding.fundingSourceType === "exchange") {
  investorInsights.positive.push(
    createInvestorInsight({
      id: "exchange-linked-funding",

      title:
        INVESTOR_INSIGHT_TEMPLATES
          .exchangeFunding.title,

      finding:
        "The wallet appears to have been funded from a centralized exchange.",

      whyItMatters:
        INVESTOR_INSIGHT_TEMPLATES
          .exchangeFunding
          .whyItMatters,

      impact: "positive",

      confidence:
        funding.evidenceConfidence,

      severity: "medium",

      evidenceRecordIds: [
        "funding-assessment",
      ],

      limitations: [
        "Funding attribution reflects the currently analyzed transaction history.",
      ],
    }),
  );
}

if (funding.fundingSourceType === "wallet") {
  investorInsights.positive.push(
    createInvestorInsight({
      id: "identifiable-funding-wallet",

      title: "Identifiable Funding Wallet",

      finding:
        funding.fundingWallet
          ? `The wallet appears to have received its initial funding from ${funding.fundingWallet}.`
          : "The wallet appears to have been funded by another identifiable blockchain wallet.",

      whyItMatters:
        "Identifying a funding wallet provides additional context about the wallet's origin and creates a traceable relationship for further analysis.",

      impact: "positive",

      confidence:
        funding.evidenceConfidence,

      severity: "medium",

      evidenceRecordIds: [
        "funding-assessment",
      ],

      limitations: [
        "The identified funding relationship does not by itself establish ownership, control, or intent.",
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
