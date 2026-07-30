import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletFundingSummary,
  WalletPortfolioSummary,
  WalletRiskSummary,
  WalletWhaleSummary,
} from "../types";

import {
  createConfidenceResponse,
} from "../confidence/framework";

import {
  createInvestorInsight,
} from "../explainability/builder";

import {
  InvestorEvidenceCollection,
} from "../explainability/evidenceCollection";

export function analyzeWalletWhaleStatus(
  portfolio: WalletPortfolioSummary,
  age: WalletAgeSummary,
  activity: WalletActivitySummary,
  funding: WalletFundingSummary,
  risk: WalletRiskSummary,
  nativeSymbol: string,
): WalletWhaleSummary {
  const estimatedPortfolioUsdValue =
    typeof portfolio.estimatedTotalUsdValue === "number"
      ? portfolio.estimatedTotalUsdValue
      : null;

  const reasons: string[] = [];
  const limitations: string[] = [];

  let whaleScore = 0;

  /*
   * Signal 1:
   * Estimated portfolio USD value.
   *
   * USD value is the strongest direct indicator of wallet size.
   * The scoring remains capped so valuation cannot determine the
   * entire whale classification by itself.
   */
  if (estimatedPortfolioUsdValue === null) {
    reasons.push(
      "USD portfolio value is unavailable, so wallet size confidence is limited.",
    );

    limitations.push(
      "The wallet's total USD portfolio value could not be determined.",
    );
  } else if (estimatedPortfolioUsdValue >= 1_000_000) {
    whaleScore += 40;

    reasons.push(
      "Estimated portfolio value is at least $1,000,000.",
    );
  } else if (estimatedPortfolioUsdValue >= 250_000) {
    whaleScore += 30;

    reasons.push(
      "Estimated portfolio value is at least $250,000.",
    );
  } else if (estimatedPortfolioUsdValue >= 50_000) {
    whaleScore += 20;

    reasons.push(
      "Estimated portfolio value is at least $50,000.",
    );
  } else {
    reasons.push(
      "Estimated portfolio value is below whale thresholds.",
    );
  }

  /*
   * Signal 2:
   * Wallet age.
   *
   * An older wallet provides more historical evidence and can
   * strengthen a whale classification when combined with other
   * portfolio and behavioral indicators.
   */
  if (age.classification === "veteran") {
    whaleScore += 20;

    reasons.push(
      "Wallet has veteran age classification.",
    );
  } else if (age.classification === "established") {
    whaleScore += 12;

    reasons.push(
      "Wallet has established age classification.",
    );
  } else if (age.classification === "new") {
    whaleScore += 3;

    reasons.push(
      "Wallet is newly created or recently first observed.",
    );
  } else {
    reasons.push(
      "Wallet age is unknown.",
    );

    limitations.push(
      "Wallet age could not be confidently determined.",
    );
  }

  /*
   * Signal 3:
   * Recent wallet activity.
   *
   * Active wallets provide more observable evidence than wallets
   * with no recent transactions in the analyzed sample.
   */
  if (activity.activityLevel === "high") {
    whaleScore += 15;

    reasons.push(
      "Wallet has high recent activity.",
    );
  } else if (activity.activityLevel === "medium") {
    whaleScore += 10;

    reasons.push(
      "Wallet has medium recent activity.",
    );
  } else if (activity.activityLevel === "low") {
    whaleScore += 5;

    reasons.push(
      "Wallet has low recent activity.",
    );
  } else {
    reasons.push(
      "Wallet has no recent activity in the current sample.",
    );

    limitations.push(
      "No recent activity was identified in the analyzed transaction sample.",
    );
  }

  /*
   * Signal 4:
   * Portfolio diversity.
   *
   * Diversity can support the interpretation that the wallet
   * controls a broader portfolio, although diversity alone does
   * not prove substantial monetary value.
   */
  if (portfolio.diversityLevel === "high") {
    whaleScore += 10;

    reasons.push(
      "Wallet portfolio has high token diversity.",
    );
  } else if (portfolio.diversityLevel === "medium") {
    whaleScore += 6;

    reasons.push(
      "Wallet portfolio has medium token diversity.",
    );
  } else if (portfolio.diversityLevel === "low") {
    whaleScore += 2;

    reasons.push(
      "Wallet portfolio has low token diversity.",
    );
  } else {
    reasons.push(
      "Wallet has no detected token portfolio diversity.",
    );
  }

  /*
   * Signal 5:
   * Original funding context.
   *
   * Funding source information can provide useful context about
   * how the wallet entered the ecosystem.
   */
  if (funding.fundingSourceType === "exchange") {
    whaleScore += 10;

    reasons.push(
      "Wallet appears to have been funded by a centralized exchange.",
    );
  } else if (funding.fundingSourceType === "bridge") {
    whaleScore += 8;

    reasons.push(
      "Wallet appears to have been funded by a bridge.",
    );
  } else if (funding.fundingSourceType === "wallet") {
    whaleScore += 5;

    reasons.push(
      "Wallet appears to have been funded by another wallet.",
    );
  } else {
    reasons.push(
      "Funding source type is unknown.",
    );

    limitations.push(
      "The original funding source could not be identified.",
    );
  }

  /*
   * Signal 6:
   * Current wallet risk.
   *
   * A lower calculated risk level provides more confidence when
   * interpreting whale characteristics. Risk does not directly
   * determine wallet size.
   */
  if (risk.level === "low") {
    whaleScore += 5;

    reasons.push(
      "Current risk level is low.",
    );
  } else if (risk.level === "medium") {
    whaleScore += 2;

    reasons.push(
      "Current risk level is medium.",
    );
  } else {
    reasons.push(
      "Current risk level is high, reducing whale confidence.",
    );
  }

  whaleScore = Math.max(
    0,
    Math.min(100, whaleScore),
  );

  const whaleLevel =
    whaleScore >= 80
      ? "large"
      : whaleScore >= 55
        ? "medium"
        : whaleScore >= 30
          ? "small"
          : "none";

  /*
   * Confidence is separate from whale level.
   *
   * Whale level estimates the wallet's size characteristics.
   * Confidence measures how much evidence supports that estimate.
   */
  const confidenceAnalysis =
    createConfidenceResponse([
      {
        condition:
          estimatedPortfolioUsdValue !== null,

        score: 35,

        reason:
          "Estimated portfolio USD value was available.",
      },

      {
        condition:
          age.classification !== "unknown",

        score: 15,

        reason:
          "Wallet age evidence was available.",
      },

      {
        condition:
          typeof activity.recentTransactionCount ===
          "number",

        score: 15,

        reason:
          "Wallet activity metrics were available.",
      },

      {
        condition:
          typeof portfolio.tokenCount === "number",

        score: 15,

        reason:
          "Portfolio composition data was available.",
      },

      {
        condition:
          funding.evidenceConfidence === "high",

        score: 10,

        reason:
          "Funding evidence confidence is high.",
      },

      {
        condition:
          funding.evidenceConfidence === "medium",

        score: 5,

        reason:
          "Funding evidence confidence is medium.",
      },

      {
        condition:
          Boolean(risk.level),

        score: 10,

        reason:
          "A wallet risk assessment was available.",
      },
    ]);

  const confidence =
    estimatedPortfolioUsdValue !== null &&
    confidenceAnalysis.level === "high"
      ? "high"
      : confidenceAnalysis.level === "low"
        ? "low"
        : "medium";

  /*
   * General analytical limitations.
   */
  limitations.push(
    "Whale status is an analytical classification and does not establish the wallet owner's identity, wealth, control, or investment experience.",
  );

  limitations.push(
    "Token balances and market values can change after the investigation is completed.",
  );

  /*
   * Investor insights are separated into positive, neutral,
   * and negative findings for reuse by the API, dashboard,
   * Intelligence Brief, and future investigation report.
   */
  const investorInsights: InvestorEvidenceCollection = {
    positive: [],
    neutral: [],
    negative: [],
  };

  /*
   * Overall whale classification.
   */
  if (whaleLevel === "large") {
    investorInsights.positive.push(
      createInvestorInsight({
        id: "large-whale-characteristics",

        title: "Large Whale Characteristics",

        finding:
          `The wallet has a large whale classification with an internal whale score of ${whaleScore} out of 100.`,

        whyItMatters:
          "A large whale classification indicates that several strong wallet-size, portfolio, age, or activity indicators were identified.",

        impact: "positive",

        confidence,

        severity: "high",

        evidenceRecordIds: [
          "whale-assessment",
          "portfolio-summary",
        ],

        limitations: [
          "Whale classification does not prove beneficial trading skill, profitability, ownership, or control of all assets.",
          "The classification may change when portfolio balances or market prices change.",
        ],
      }),
    );
  }

  if (whaleLevel === "medium") {
    investorInsights.positive.push(
      createInvestorInsight({
        id: "medium-whale-characteristics",

        title: "Meaningful Whale Characteristics",

        finding:
          `The wallet has a medium whale classification with an internal whale score of ${whaleScore} out of 100.`,

        whyItMatters:
          "The wallet demonstrates several characteristics associated with larger or more established market participants.",

        impact: "positive",

        confidence,

        severity: "medium",

        evidenceRecordIds: [
          "whale-assessment",
          "portfolio-summary",
        ],

        limitations: [
          "The classification does not establish the identity, experience, profitability, or intent of the wallet owner.",
          "Some whale indicators are analytical inferences rather than direct proof of portfolio value.",
        ],
      }),
    );
  }

  if (whaleLevel === "small") {
    investorInsights.neutral.push(
      createInvestorInsight({
        id: "small-whale-characteristics",

        title: "Early Whale Characteristics",

        finding:
          `The wallet has a small whale classification with an internal whale score of ${whaleScore} out of 100.`,

        whyItMatters:
          "The wallet shows some characteristics associated with larger or more established wallets, but the available evidence does not support a stronger classification.",

        impact: "neutral",

        confidence,

        severity: "medium",

        evidenceRecordIds: [
          "whale-assessment",
          "portfolio-summary",
        ],

        limitations: [
          "A small whale classification does not necessarily mean that the wallet controls a high-value portfolio.",
          "The result may be influenced by wallet age, activity, diversity, and funding context when USD valuation is unavailable.",
        ],
      }),
    );
  }

  if (whaleLevel === "none") {
    investorInsights.neutral.push(
      createInvestorInsight({
        id: "no-strong-whale-characteristics",

        title: "No Strong Whale Classification",

        finding:
          `The wallet does not currently meet the model's whale thresholds and has an internal whale score of ${whaleScore} out of 100.`,

        whyItMatters:
          "The currently available evidence does not strongly indicate that the wallet controls a whale-sized portfolio or demonstrates enough supporting whale characteristics.",

        impact: "neutral",

        confidence,

        severity: "low",

        evidenceRecordIds: [
          "whale-assessment",
        ],

        limitations: [
          "This does not prove that the wallet owner lacks substantial assets elsewhere.",
          "Assets held through other wallets, exchanges, custodians, protocols, or unsupported chains may not be visible in this assessment.",
        ],
      }),
    );
  }

  /*
   * USD portfolio valuation insight.
   */
  if (estimatedPortfolioUsdValue === null) {
    investorInsights.neutral.push(
      createInvestorInsight({
        id: "whale-usd-valuation-unavailable",

        title: "USD Portfolio Valuation Unavailable",

        finding:
          "The wallet's total portfolio value could not be reliably converted into USD.",

        whyItMatters:
          "USD valuation is the strongest direct indicator for determining whether a wallet controls a whale-sized portfolio.",

        impact: "neutral",

        confidence: "high",

        severity: "high",

        evidenceRecordIds: [
          "portfolio-summary",
          "whale-assessment",
        ],

        limitations: [
          "Some tokens may not have supported or sufficiently reliable market prices.",
          "The whale score therefore relies more heavily on indirect indicators such as age, activity, diversity, funding, and risk.",
        ],
      }),
    );
  } else {
    investorInsights.positive.push(
      createInvestorInsight({
        id: "whale-usd-valuation-available",

        title: "Portfolio Valuation Available",

        finding:
          `The wallet's estimated portfolio value is approximately $${formatUsdValue(
            estimatedPortfolioUsdValue,
          )}.`,

        whyItMatters:
          "An available USD valuation provides direct evidence for evaluating the wallet's financial size.",

        impact: "positive",

        confidence: "high",

        severity: "medium",

        evidenceRecordIds: [
          "portfolio-summary",
          "whale-assessment",
        ],

        limitations: [
          "The valuation is an estimate based on the available token prices at the time of investigation.",
          "Low-liquidity tokens may not be realizable at their displayed market value.",
        ],
      }),
    );
  }

  /*
   * Wallet age insight.
   */
  if (
    age.classification === "veteran" ||
    age.classification === "established"
  ) {
    investorInsights.positive.push(
      createInvestorInsight({
        id: "established-whale-history",

        title: "Established Wallet History",

        finding:
          `The wallet has a ${age.classification} age classification.`,

        whyItMatters:
          "A longer wallet history provides more evidence for evaluating whether the observed portfolio and activity characteristics are persistent rather than temporary.",

        impact: "positive",

        confidence: "high",

        severity: "medium",

        evidenceRecordIds: [
          "wallet-age",
          "whale-assessment",
        ],

        limitations: [
          "Wallet age does not prove continuous ownership, profitability, or legitimate activity.",
          "The first known transaction may not represent the wallet owner's first activity on another address or blockchain.",
        ],
      }),
    );
  }

  /*
   * Portfolio diversity insight.
   */
  if (
    portfolio.diversityLevel === "medium" ||
    portfolio.diversityLevel === "high"
  ) {
    investorInsights.positive.push(
      createInvestorInsight({
        id: "meaningful-portfolio-diversity",

        title: "Meaningful Portfolio Diversity",

        finding:
          `The wallet has ${portfolio.diversityLevel} token portfolio diversity across ${portfolio.tokenCount} detected token holding(s).`,

        whyItMatters:
          "A broader portfolio can indicate more extensive market participation than a wallet holding only one asset.",

        impact: "positive",

        confidence: "high",

        severity: "low",

        evidenceRecordIds: [
          "portfolio-summary",
          "whale-assessment",
        ],

        limitations: [
          "Token count and diversity do not establish portfolio quality, liquidity, or monetary value.",
          "Very small or unsolicited token balances can increase the detected token count.",
        ],
      }),
    );
  }

  /*
   * Recent activity insight.
   */
  if (
    activity.activityLevel === "medium" ||
    activity.activityLevel === "high"
  ) {
    investorInsights.positive.push(
      createInvestorInsight({
        id: "active-whale-profile",

        title: "Active Wallet Profile",

        finding:
          `The wallet has ${activity.activityLevel} recent blockchain activity.`,

        whyItMatters:
          "Recent activity provides current evidence that the wallet is being used and allows the model to evaluate more than static balances alone.",

        impact: "positive",

        confidence: "high",

        severity: "low",

        evidenceRecordIds: [
          "activity-summary",
          "whale-assessment",
        ],

        limitations: [
          "Activity level is based on the analyzed transaction sample and may not represent the wallet's complete history.",
          "High transaction activity does not necessarily indicate high portfolio value or successful investment decisions.",
        ],
      }),
    );
  }

  /*
   * Unknown funding insight.
   */
  if (funding.fundingSourceType === "unknown") {
    investorInsights.neutral.push(
      createInvestorInsight({
        id: "whale-funding-source-unknown",

        title: "Funding Source Could Not Be Confirmed",

        finding:
          "The wallet's original funding source could not be confidently identified.",

        whyItMatters:
          "Funding origin can provide useful context about whether assets entered through an exchange, bridge, another wallet, or an on-chain program.",

        impact: "neutral",

        confidence:
          funding.evidenceConfidence,

        severity: "medium",

        evidenceRecordIds: [
          "funding-assessment",
          "whale-assessment",
        ],

        limitations: [
          "The first known transaction may not contain the wallet's complete funding history.",
          `Token transfers or indirect funding routes may not be represented by an incoming native ${nativeSymbol} transfer.`,
        ],
      }),
    );
  }

  /*
   * High-risk context.
   *
   * High risk does not reduce the numerical wallet size directly,
   * but it is important context for investors interpreting whale status.
   */
  if (risk.level === "high") {
    investorInsights.negative.push(
      createInvestorInsight({
        id: "high-risk-whale-context",

        title: "High-Risk Whale Context",

        finding:
          "The wallet currently has a high calculated risk level alongside its whale assessment.",

        whyItMatters:
          "A wallet may control significant assets while still presenting elevated risk indicators that require separate investigation.",

        impact: "negative",

        confidence:
          risk.confidence ?? risk.evidenceConfidence ?? "medium",

        severity: "high",

        evidenceRecordIds: [
          "risk-assessment",
          "whale-assessment",
        ],

        limitations: [
          "A high calculated risk score does not prove illegal activity, malicious intent, or ownership.",
          "Whale status and risk level measure different characteristics and should not be treated as the same conclusion.",
        ],
      }),
    );
  }

  return {
    isWhale:
      whaleLevel !== "none",

    whaleScore,

    whaleLevel,

    estimatedPortfolioUsdValue,

    evidenceConfidence:
      confidenceAnalysis.level,

    confidenceAnalysis,

    confidence,

    reasons,

    limitations,

    investorExplanation: {
      summary:
        buildInvestorWhaleSummary(
          whaleLevel,
          whaleScore,
          estimatedPortfolioUsdValue,
        ),

      whyThisAssessment:
        buildWhaleExplanation(
          reasons,
        ),

      whatReducedConfidence:
        limitations,
    },

    investorInsights,
  };
}

function buildInvestorWhaleSummary(
  whaleLevel: WalletWhaleSummary["whaleLevel"],
  whaleScore: number,
  estimatedPortfolioUsdValue: number | null,
): string {
  const valuationContext =
    estimatedPortfolioUsdValue === null
      ? "A complete USD portfolio valuation was unavailable, so the classification relies partly on indirect indicators."
      : `The estimated portfolio value is approximately $${formatUsdValue(
          estimatedPortfolioUsdValue,
        )}.`;

  switch (whaleLevel) {
    case "large":
      return `This wallet shows large whale characteristics with an internal whale score of ${whaleScore} out of 100. ${valuationContext}`;

    case "medium":
      return `This wallet shows meaningful whale characteristics with an internal whale score of ${whaleScore} out of 100. ${valuationContext}`;

    case "small":
      return `This wallet shows early or limited whale characteristics with an internal whale score of ${whaleScore} out of 100. ${valuationContext}`;

    case "none":
    default:
      return `This wallet does not currently meet the model's whale thresholds and has an internal whale score of ${whaleScore} out of 100. ${valuationContext}`;
  }
}

function buildWhaleExplanation(
  reasons: string[],
): string[] {
  return reasons.map((reason) => {
    if (
      reason ===
      "USD portfolio value is unavailable, so wallet size confidence is limited."
    ) {
      return "A reliable USD portfolio valuation was unavailable, so the model relied more heavily on wallet age, activity, portfolio diversity, funding context, and risk.";
    }

    if (
      reason ===
      "Estimated portfolio value is at least $1,000,000."
    ) {
      return "The available token prices indicate an estimated portfolio value of at least one million US dollars.";
    }

    if (
      reason ===
      "Estimated portfolio value is at least $250,000."
    ) {
      return "The available token prices indicate an estimated portfolio value of at least two hundred and fifty thousand US dollars.";
    }

    if (
      reason ===
      "Estimated portfolio value is at least $50,000."
    ) {
      return "The available token prices indicate an estimated portfolio value of at least fifty thousand US dollars.";
    }

    if (
      reason ===
      "Estimated portfolio value is below whale thresholds."
    ) {
      return "The available USD valuation is below the model's direct whale-value thresholds.";
    }

    if (
      reason ===
      "Wallet has veteran age classification."
    ) {
      return "The wallet has a long blockchain history, providing stronger historical evidence for the assessment.";
    }

    if (
      reason ===
      "Wallet has established age classification."
    ) {
      return "The wallet has an established blockchain history, which supports interpretation of its current portfolio and activity.";
    }

    if (
      reason ===
      "Wallet is newly created or recently first observed."
    ) {
      return "The wallet has limited historical evidence because it was created or first observed relatively recently.";
    }

    if (
      reason ===
      "Wallet age is unknown."
    ) {
      return "The wallet's first known activity could not be confidently determined.";
    }

    if (
      reason ===
      "Wallet has high recent activity."
    ) {
      return "The wallet shows a high level of recent blockchain activity in the analyzed sample.";
    }

    if (
      reason ===
      "Wallet has medium recent activity."
    ) {
      return "The wallet shows a moderate level of recent blockchain activity in the analyzed sample.";
    }

    if (
      reason ===
      "Wallet has low recent activity."
    ) {
      return "The wallet shows a limited level of recent blockchain activity in the analyzed sample.";
    }

    if (
      reason ===
      "Wallet has no recent activity in the current sample."
    ) {
      return "No recent transactions were available for evaluating the wallet's current activity profile.";
    }

    if (
      reason ===
      "Wallet portfolio has high token diversity."
    ) {
      return "The wallet holds a broadly diversified token portfolio, which contributes to its wallet-size profile.";
    }

    if (
      reason ===
      "Wallet portfolio has medium token diversity."
    ) {
      return "The wallet holds a moderately diversified token portfolio, which contributes to its wallet-size profile.";
    }

    if (
      reason ===
      "Wallet portfolio has low token diversity."
    ) {
      return "The wallet has limited token diversity, providing only a small contribution to the whale assessment.";
    }

    if (
      reason ===
      "Wallet has no detected token portfolio diversity."
    ) {
      return "No meaningful token portfolio diversity was detected.";
    }

    if (
      reason ===
      "Wallet appears to have been funded by a centralized exchange."
    ) {
      return "The available funding evidence suggests that the wallet originally received assets from a centralized exchange.";
    }

    if (
      reason ===
      "Wallet appears to have been funded by a bridge."
    ) {
      return "The available funding evidence suggests that the wallet originally received assets through a blockchain bridge.";
    }

    if (
      reason ===
      "Wallet appears to have been funded by another wallet."
    ) {
      return "The available funding evidence suggests that another wallet provided the original funding.";
    }

    if (
      reason ===
      "Funding source type is unknown."
    ) {
      return "The wallet's original funding route could not be confidently identified.";
    }

    if (
      reason ===
      "Current risk level is low."
    ) {
      return "The current calculated wallet risk is low, which provides more reassuring context for the whale classification.";
    }

    if (
      reason ===
      "Current risk level is medium."
    ) {
      return "The wallet has a medium calculated risk level, which adds some caution to interpretation of the whale classification.";
    }

    if (
      reason ===
      "Current risk level is high, reducing whale confidence."
    ) {
      return "The wallet has a high calculated risk level, which requires the whale classification to be interpreted cautiously.";
    }

    return reason;
  });
}

function formatUsdValue(
  value: number,
): string {
  return value.toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  );
}
