import {
  WalletActivitySummary,
  WalletRiskSummary,
} from "../types";

import {
  buildConfidenceInput,
  confidenceLevelFromScore,
} from "../confidence/framework";

import { createInvestorInsight } from "../explainability/builder";
import { InvestorEvidenceCollection } from "../explainability/evidenceCollection";

export function analyzeWalletRisk(
  solBalance: number,
  activity: WalletActivitySummary,
): WalletRiskSummary {
  const reasons: string[] = [];
  const limitations: string[] = [];

  let score = 0;

  /*
   * Risk signal 1:
   * The wallet currently has no native SOL balance.
   *
   * This adds only a small amount of risk because a zero balance
   * can have many legitimate explanations.
   */
  if (solBalance === 0) {
    score += 5;

    reasons.push(
      "Wallet currently has zero SOL balance.",
    );
  }

  /*
   * Risk signal 2:
   * Failed transactions were identified.
   *
   * Each failed transaction adds risk, but the contribution
   * is capped at 30 points so this signal cannot dominate
   * the entire assessment by itself.
   */
  if (activity.failedTransactionCount > 0) {
    score += Math.min(
      activity.failedTransactionCount * 10,
      30,
    );

    reasons.push(
      `${activity.failedTransactionCount} failed transaction(s) found in the recent sample.`,
    );
  }

  /*
   * Risk signal 3:
   * No recent transaction activity was identified.
   *
   * Inactivity adds limited uncertainty, but it does not
   * automatically mean that the wallet is suspicious.
   */
  if (activity.recentTransactionCount === 0) {
    score += 10;

    reasons.push(
      "No recent transaction activity found.",
    );

    limitations.push(
      "No recent transactions were available for evaluating current wallet behavior.",
    );
  } else {
    reasons.push(
      "Wallet has recent transaction activity.",
    );
  }

  /*
   * The score is constrained to the supported 0–100 range.
   */
  score = Math.max(
    0,
    Math.min(100, score),
  );

  /*
   * Convert the numerical score into an investor-readable
   * risk classification.
   */
  const level =
    score >= 60
      ? "high"
      : score >= 25
        ? "medium"
        : "low";

  /*
   * Confidence measures the strength of the available evidence.
   *
   * This is intentionally separate from the risk level:
   *
   * - risk level describes the calculated concern;
   * - confidence describes how much evidence supports it.
   */
  const confidenceInput = buildConfidenceInput([
    {
      condition:
        activity.recentTransactionCount > 0,

      score: 40,

      reason:
        "Recent transaction activity was available for analysis.",
    },

    {
      condition:
        activity.recentTransactionCount >= 5,

      score: 30,

      reason:
        "Several recent transactions were available for comparison.",
    },

    {
      condition:
        activity.activityLevel !== "none",

      score: 20,

      reason:
        "The wallet has a measurable recent activity profile.",
    },

    {
      condition:
        Number.isFinite(solBalance),

      score: 10,

      reason:
        "The wallet's current native balance was available.",
    },
  ]);

  const evidenceConfidence =
    confidenceLevelFromScore(
      confidenceInput.score,
    );

  const confidence =
    evidenceConfidence;

  /*
   * Add transparent evidence limitations.
   */
  limitations.push(
    "The risk assessment is based on the currently analyzed transaction sample and does not represent the wallet's complete lifetime history.",
  );

  limitations.push(
    "The current risk model uses observable blockchain indicators and does not determine ownership, intent, identity, or legality.",
  );

  /*
   * Investor Insights
   *
   * These convert analytical results into structured,
   * reusable explanations for the API, dashboard,
   * Intelligence Brief, and future PDF report.
   */
  const investorInsights: InvestorEvidenceCollection = {
    positive: [],
    neutral: [],
    negative: [],
  };

  /*
   * Overall low-risk assessment.
   */
  if (level === "low") {
    investorInsights.positive.push(
      createInvestorInsight({
        id: "low-calculated-wallet-risk",

        title: "Low Calculated Wallet Risk",

        finding:
          `The wallet currently has a low calculated risk level with an internal score of ${score} out of 100.`,

        whyItMatters:
          "The currently observed blockchain indicators contain few signals that materially increase the calculated wallet risk.",

        impact: "positive",

        confidence,

        severity: "medium",

        evidenceRecordIds: [
          "risk-assessment",
        ],

        limitations: [
          "A low calculated risk level does not guarantee that the wallet is safe, legitimate, or free from undiscovered exposure.",
          "The result reflects only the blockchain evidence and analytical rules available at the time of investigation.",
        ],
      }),
    );
  }

  /*
   * Overall medium-risk assessment.
   */
  if (level === "medium") {
    investorInsights.negative.push(
      createInvestorInsight({
        id: "medium-calculated-wallet-risk",

        title: "Elevated Wallet Risk Indicators",

        finding:
          `The wallet currently has a medium calculated risk level with an internal score of ${score} out of 100.`,

        whyItMatters:
          "A medium risk level indicates that one or more observed blockchain indicators require additional context before the wallet can be fully understood.",

        impact: "negative",

        confidence,

        severity: "high",

        evidenceRecordIds: [
          "risk-assessment",
        ],

        limitations: [
          "The calculated score does not establish wrongdoing, ownership, control, or harmful intent.",
          "The result may change when additional transactions, labels, relationships, or external intelligence sources become available.",
        ],
      }),
    );
  }

  /*
   * Overall high-risk assessment.
   */
  if (level === "high") {
    investorInsights.negative.push(
      createInvestorInsight({
        id: "high-calculated-wallet-risk",

        title: "High Wallet Risk Indicators",

        finding:
          `The wallet currently has a high calculated risk level with an internal score of ${score} out of 100.`,

        whyItMatters:
          "A high calculated risk level means that the available blockchain evidence contains multiple or strongly weighted indicators requiring careful interpretation.",

        impact: "negative",

        confidence,

        severity: "critical",

        evidenceRecordIds: [
          "risk-assessment",
        ],

        limitations: [
          "A high calculated risk score does not by itself prove illegal activity, malicious intent, or common ownership.",
          "The result is limited by the transaction sample and intelligence sources available during the investigation.",
        ],
      }),
    );
  }

  /*
   * Failed transaction insight.
   */
  if (activity.failedTransactionCount > 0) {
    investorInsights.negative.push(
      createInvestorInsight({
        id: "failed-transaction-indicators",

        title: "Failed Transaction Indicators",

        finding:
          `${activity.failedTransactionCount} failed transaction(s) were identified in the recent transaction sample.`,

        whyItMatters:
          "Repeated failed transactions can reflect unsuccessful contract interactions, insufficient balances, incorrect parameters, automated activity, or other operational difficulties.",

        impact: "negative",

        confidence: "high",

        severity:
          activity.failedTransactionCount >= 3
            ? "high"
            : "medium",

        evidenceRecordIds: [
          "activity-summary",
          "risk-assessment",
        ],

        limitations: [
          "A failed transaction does not by itself indicate fraud, malicious intent, or suspicious behavior.",
          "Some failures can result from ordinary technical errors, network conditions, or user mistakes.",
        ],
      }),
    );
  }

  /*
   * No recent activity insight.
   */
  if (activity.recentTransactionCount === 0) {
    investorInsights.neutral.push(
      createInvestorInsight({
        id: "limited-risk-activity-evidence",

        title: "Limited Recent Risk Evidence",

        finding:
          "No recent transaction activity was available for evaluating the wallet's current behavioral risk indicators.",

        whyItMatters:
          "Without recent transactions, the assessment relies on a smaller amount of current behavioral evidence.",

        impact: "neutral",

        confidence: "high",

        severity: "low",

        evidenceRecordIds: [
          "activity-summary",
          "risk-assessment",
        ],

        limitations: [
          "Inactivity does not by itself indicate elevated risk.",
          "The wallet may have historical activity outside the analyzed transaction sample.",
        ],
      }),
    );
  }

  /*
   * Zero native balance insight.
   */
  if (solBalance === 0) {
    investorInsights.neutral.push(
      createInvestorInsight({
        id: "zero-native-balance",

        title: "Zero Native Balance",

        finding:
          "The wallet currently holds no native SOL balance.",

        whyItMatters:
          "A zero native balance may indicate inactivity, an emptied wallet, a temporary balance state, or limited ability to submit new transactions without receiving additional SOL.",

        impact: "neutral",

        confidence: "high",

        severity: "low",

        evidenceRecordIds: [
          "risk-assessment",
        ],

        limitations: [
          "A zero SOL balance does not by itself indicate suspicious activity.",
          "The balance represents the wallet state at the time of investigation and may change later.",
        ],
      }),
    );
  }

  return {
    score,

    level,

    evidenceConfidence,

    confidenceAnalysis:
      confidenceInput,

    confidence,

    reasons,

    limitations,

    investorExplanation: {
      summary:
        buildInvestorRiskSummary(
          level,
          score,
        ),

      whyThisAssessment:
        buildRiskExplanation(
          reasons,
        ),

      whatReducedConfidence:
        limitations,
    },

    investorInsights,
  };
}

function buildInvestorRiskSummary(
  level: WalletRiskSummary["level"],
  score: number,
): string {
  switch (level) {
    case "high":
      return `This wallet currently has a high calculated risk level with a score of ${score} out of 100. Multiple or strongly weighted indicators contributed to the assessment.`;

    case "medium":
      return `This wallet currently has a medium calculated risk level with a score of ${score} out of 100. Some indicators require additional context and interpretation.`;

    case "low":
    default:
      return `This wallet currently has a low calculated risk level with a score of ${score} out of 100. Few material risk indicators were identified in the analyzed evidence.`;
  }
}

function buildRiskExplanation(
  reasons: string[],
): string[] {
  return reasons.map((reason) => {
    if (
      reason ===
      "Wallet currently has zero SOL balance."
    ) {
      return "The wallet currently has no native SOL balance, which adds a small amount of uncertainty but is not inherently suspicious.";
    }

    if (
      reason ===
      "No recent transaction activity found."
    ) {
      return "No recent transactions were available for evaluating the wallet's current behavior.";
    }

    if (
      reason ===
      "Wallet has recent transaction activity."
    ) {
      return "Recent transactions provided current behavioral evidence for the risk assessment.";
    }

    if (
      reason.includes(
        "failed transaction(s)",
      )
    ) {
      return "Failed transactions were identified in the recent sample and contributed to the calculated risk score.";
    }

    return reason;
  });
}
