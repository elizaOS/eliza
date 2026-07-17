import {
  WalletActivitySummary,
  WalletAgeSummary,
  WalletDeFiSummary,
  WalletPortfolioSummary,
  WalletSmartMoneySummary,
  WalletTrustSummary,
  WalletWhaleSummary,
} from "../types";
import {
  createConfidenceResponse,
} from "../confidence/framework";

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
    positiveSignals.push(
      "Wallet has a long activity history.",
    );
  } else if (age.classification === "established") {
    smartMoneyScore += 12;
    positiveSignals.push("Wallet is established.");
  } else {
    limitations.push(
      "Wallet does not yet show a long-term history.",
    );
  }

  if (activity.activityLevel === "high") {
    smartMoneyScore += 20;
    positiveSignals.push(
      "Wallet shows high recent activity.",
    );
  } else if (activity.activityLevel === "medium") {
    smartMoneyScore += 12;
    positiveSignals.push(
      "Wallet shows moderate recent activity.",
    );
  } else {
    limitations.push(
      "Limited recent activity reduces smart money confidence.",
    );
  }

  if (
    defi.profile === "active_defi_user" ||
    defi.profile === "power_user"
  ) {
    smartMoneyScore += 20;
    positiveSignals.push(
      "Wallet uses recognized DeFi protocols.",
    );
  } else {
    limitations.push(
      "Limited recognized DeFi activity was detected.",
    );
  }

  if (portfolio.diversityLevel === "high") {
    smartMoneyScore += 15;
    positiveSignals.push(
      "Wallet has high portfolio diversity.",
    );
  } else if (portfolio.diversityLevel === "medium") {
    smartMoneyScore += 10;
    positiveSignals.push(
      "Wallet has medium portfolio diversity.",
    );
  } else {
    limitations.push("Portfolio diversity is limited.");
  }

  if (whale.isWhale) {
    smartMoneyScore += 15;
    positiveSignals.push(
      "Wallet has whale-level characteristics.",
    );
  }

  if (
    trust.trustLevel === "high" ||
    trust.trustLevel === "very_high"
  ) {
    smartMoneyScore += 10;
    positiveSignals.push(
      "Wallet has strong trust signals.",
    );
  } else if (trust.trustLevel === "medium") {
    smartMoneyScore += 5;
    positiveSignals.push(
      "Wallet has moderate trust signals.",
    );
  } else {
    limitations.push("Trust signals are limited.");
  }

  smartMoneyScore = Math.max(
    0,
    Math.min(100, smartMoneyScore),
  );

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
      : defi.profile === "active_defi_user" ||
          defi.profile === "power_user"
        ? "active_defi_participant"
        : activity.activityLevel === "high"
          ? "professional_trader"
          : age.classification === "veteran"
            ? "long_term_investor"
            : "unknown";

  const confidenceAnalysis = createConfidenceResponse([
    {
      condition: age.classification !== "unknown",
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
      condition: Boolean(defi.profile),
      score: 15,
      reason:
        "A DeFi usage profile was available.",
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
        whale.estimatedPortfolioUsdValue !== null &&
        whale.estimatedPortfolioUsdValue !== undefined,
      score: 20,
      reason:
        "Estimated portfolio USD value was available.",
    },
    {
      condition:
        trust.evidenceConfidence === "high",
      score: 20,
      reason:
        "Trust evidence confidence is high.",
    },
    {
      condition:
        trust.evidenceConfidence === "medium",
      score: 10,
      reason:
        "Trust evidence confidence is medium.",
    },
  ]);

  const confidence =
    positiveSignals.length >= 4
      ? "high"
      : positiveSignals.length >= 2
        ? "medium"
        : "low";

  const investorExplanation = {
    summary: buildInvestorSmartMoneySummary(
      level,
      profile,
      smartMoneyScore,
    ),

    whyThisAssessment: buildSmartMoneyExplanation(
      age,
      activity,
      defi,
      portfolio,
      whale,
      trust,
    ),

    whatReducedConfidence: [...limitations],
  };

  const positiveInsights: NonNullable<
    WalletSmartMoneySummary["investorInsights"]
  >["positive"] = [];

  const neutralInsights: NonNullable<
    WalletSmartMoneySummary["investorInsights"]
  >["neutral"] = [];

  const negativeInsights: NonNullable<
    WalletSmartMoneySummary["investorInsights"]
  >["negative"] = [];

  if (
    level === "medium" ||
    level === "high"
  ) {
    positiveInsights.push({
      id: "smart-money-candidate",
      title: "Smart Money Candidate",
      finding:
        `The wallet qualifies as a smart-money candidate ` +
        `with a ${level} classification and an internal ` +
        `score of ${smartMoneyScore} out of 100.`,
      whyItMatters:
        "The wallet combines multiple characteristics commonly associated with experienced or strategically active blockchain participants.",
      impact: "positive",
      confidence,
      severity:
        level === "high" ? "high" : "medium",
      evidenceRecordIds: [
        "smart-money-assessment",
        "activity-summary",
        "portfolio-summary",
      ],
      limitations: [
        "Smart-money classification does not prove profitability, investment skill, ownership identity, or future performance.",
        "The result reflects the evidence and analytical rules available at the time of investigation.",
      ],
    });
  } else {
    neutralInsights.push({
      id: "limited-smart-money-evidence",
      title: "Limited Smart Money Evidence",
      finding:
        `The wallet has a ${level} smart-money ` +
        `classification with an internal score of ` +
        `${smartMoneyScore} out of 100.`,
      whyItMatters:
        "The available evidence does not currently show a sufficiently strong combination of wallet history, activity, DeFi usage, portfolio structure, whale characteristics, and trust.",
      impact: "neutral",
      confidence,
      severity: "medium",
      evidenceRecordIds: [
        "smart-money-assessment",
      ],
      limitations: [
        "A low smart-money score does not mean that the wallet is unprofitable or inexperienced.",
        "Undetected activity, unsupported protocols, other wallet addresses, or off-chain trading may affect the interpretation.",
      ],
    });
  }

  if (age.classification === "veteran") {
    positiveInsights.push({
      id: "veteran-smart-money-history",
      title: "Long-Term Wallet History",
      finding:
        "The wallet has a veteran age classification.",
      whyItMatters:
        "A long blockchain history provides more evidence for evaluating whether the wallet's activity and portfolio behavior are persistent rather than temporary.",
      impact: "positive",
      confidence: "high",
      severity: "medium",
      evidenceRecordIds: [
        "wallet-age",
        "smart-money-assessment",
      ],
      limitations: [
        "Wallet age does not prove continuous ownership, profitability, or investment expertise.",
        "The wallet owner may also operate other addresses that are not included in this investigation.",
      ],
    });
  } else if (
    age.classification === "established"
  ) {
    positiveInsights.push({
      id: "established-smart-money-history",
      title: "Established Wallet History",
      finding:
        "The wallet has an established blockchain history.",
      whyItMatters:
        "An established wallet provides meaningful historical evidence for evaluating its activity, portfolio composition, and behavioral profile.",
      impact: "positive",
      confidence: "high",
      severity: "medium",
      evidenceRecordIds: [
        "wallet-age",
        "smart-money-assessment",
      ],
      limitations: [
        "Wallet age does not establish whether the same person or organization controlled the address throughout its history.",
        "Historical activity alone does not prove successful investment decisions.",
      ],
    });
  } else {
    neutralInsights.push({
      id: "limited-wallet-history",
      title: "Limited Wallet History",
      finding:
        `The wallet has a ${age.classification} age classification.`,
      whyItMatters:
        "A shorter or uncertain wallet history provides less evidence for identifying persistent investment or trading behavior.",
      impact: "neutral",
      confidence:
        age.classification === "unknown"
          ? "low"
          : "medium",
      severity: "medium",
      evidenceRecordIds: [
        "wallet-age",
        "smart-money-assessment",
      ],
      limitations: [
        "The wallet may be controlled by an experienced participant using a newer address.",
        "Activity performed through other wallets is not represented by this classification.",
      ],
    });
  }

  if (activity.activityLevel === "high") {
    positiveInsights.push({
      id: "high-smart-money-activity",
      title: "High Recent Activity",
      finding:
        "The wallet shows a high level of recent blockchain activity.",
      whyItMatters:
        "Frequent recent activity can indicate active portfolio management, trading, protocol participation, or ongoing capital deployment.",
      impact: "positive",
      confidence: "high",
      severity: "medium",
      evidenceRecordIds: [
        "activity-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "High activity does not establish profitability or investment quality.",
        "The activity classification is based on the analyzed transaction sample rather than the wallet's complete lifetime history.",
      ],
    });
  } else if (
    activity.activityLevel === "medium"
  ) {
    positiveInsights.push({
      id: "moderate-smart-money-activity",
      title: "Moderate Recent Activity",
      finding:
        "The wallet shows a moderate level of recent blockchain activity.",
      whyItMatters:
        "Current activity provides behavioral evidence and reduces reliance on historical balances alone.",
      impact: "positive",
      confidence: "high",
      severity: "low",
      evidenceRecordIds: [
        "activity-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "Moderate activity does not establish professional trading behavior or profitable decision-making.",
        "The analyzed sample may not represent all wallet activity.",
      ],
    });
  } else {
    neutralInsights.push({
      id: "limited-smart-money-activity",
      title: "Limited Recent Activity",
      finding:
        `The wallet currently has a ${activity.activityLevel} activity classification.`,
      whyItMatters:
        "Limited recent activity provides less current evidence for identifying active trading, portfolio management, or protocol participation.",
      impact: "neutral",
      confidence: "high",
      severity: "medium",
      evidenceRecordIds: [
        "activity-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "The wallet may be used primarily for long-term storage rather than active trading.",
        "Recent inactivity does not prove that the wallet owner lacks investment experience.",
      ],
    });
  }

  if (
    defi.profile === "active_defi_user" ||
    defi.profile === "power_user"
  ) {
    positiveInsights.push({
      id: "recognized-defi-participation",
      title: "Recognized DeFi Participation",
      finding:
        `The wallet has a ${formatProfileName(
          defi.profile,
        )} DeFi profile.`,
      whyItMatters:
        "Interaction with recognized DeFi protocols can indicate familiarity with on-chain markets, liquidity, lending, trading, or yield strategies.",
      impact: "positive",
      confidence: "medium",
      severity: "medium",
      evidenceRecordIds: [
        "defi-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "DeFi participation does not prove that the wallet's strategies were profitable or low-risk.",
        "Protocol detection is limited to the currently connected and recognized protocol registry.",
      ],
    });
  } else {
    neutralInsights.push({
      id: "limited-recognized-defi-activity",
      title: "Limited Recognized DeFi Activity",
      finding:
        "Limited interaction with recognized DeFi protocols was identified in the analyzed transaction sample.",
      whyItMatters:
        "Recognized DeFi activity is useful evidence when evaluating whether a wallet actively participates in sophisticated on-chain markets.",
      impact: "neutral",
      confidence: "medium",
      severity: "medium",
      evidenceRecordIds: [
        "defi-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "The wallet may have interacted with protocols that are not yet included in the connected registry.",
        "The analyzed transaction sample may not represent the wallet's complete DeFi history.",
      ],
    });
  }

  if (portfolio.diversityLevel === "high") {
    positiveInsights.push({
      id: "high-smart-money-diversity",
      title: "High Portfolio Diversity",
      finding:
        `The wallet has high portfolio diversity across ` +
        `${portfolio.tokenCount} detected token holding(s).`,
      whyItMatters:
        "A diversified portfolio may indicate broader market participation and more active allocation across multiple assets.",
      impact: "positive",
      confidence: "high",
      severity: "medium",
      evidenceRecordIds: [
        "portfolio-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "Portfolio diversity does not establish asset quality, liquidity, profitability, or effective risk management.",
        "Unsolicited tokens and very small balances can increase the detected token count.",
      ],
    });
  } else if (
    portfolio.diversityLevel === "medium"
  ) {
    positiveInsights.push({
      id: "medium-smart-money-diversity",
      title: "Meaningful Portfolio Diversity",
      finding:
        `The wallet has medium portfolio diversity across ` +
        `${portfolio.tokenCount} detected token holding(s).`,
      whyItMatters:
        "A portfolio containing multiple assets can indicate broader market participation than a wallet holding only one asset.",
      impact: "positive",
      confidence: "high",
      severity: "low",
      evidenceRecordIds: [
        "portfolio-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "Token count and diversity do not establish portfolio value, liquidity, or investment quality.",
        "Very small or unsolicited token balances may affect the diversity classification.",
      ],
    });
  } else {
    neutralInsights.push({
      id: "limited-portfolio-diversity",
      title: "Limited Portfolio Diversity",
      finding:
        `The wallet has a ${portfolio.diversityLevel} ` +
        `portfolio diversity classification.`,
      whyItMatters:
        "A concentrated or minimally diversified portfolio provides less evidence of broad asset allocation or active portfolio management.",
      impact: "neutral",
      confidence: "high",
      severity: "medium",
      evidenceRecordIds: [
        "portfolio-summary",
        "smart-money-assessment",
      ],
      limitations: [
        "Portfolio concentration may represent a deliberate high-conviction strategy.",
        "Diversity does not determine whether an investment strategy is successful.",
      ],
    });
  }

  if (whale.isWhale) {
    positiveInsights.push({
      id: "whale-smart-money-characteristics",
      title: "Whale-Level Characteristics",
      finding:
        `The wallet has a ${whale.whaleLevel} whale ` +
        `classification with an internal whale score of ` +
        `${whale.whaleScore} out of 100.`,
      whyItMatters:
        "Larger or more established wallet characteristics can indicate greater market participation, capital deployment, or portfolio reach.",
      impact: "positive",
      confidence: whale.evidenceConfidence,
      severity: "medium",
      evidenceRecordIds: [
        "whale-assessment",
        "smart-money-assessment",
      ],
      limitations: [
        "Whale classification does not establish ownership identity, investment skill, profitability, or control of liquid assets.",
        "The classification may rely partly on indirect indicators when complete USD valuation is unavailable.",
      ],
    });
  } else {
    neutralInsights.push({
      id: "no-strong-whale-characteristics",
      title: "No Strong Whale Classification",
      finding:
        "The wallet does not currently meet the model's whale-candidate criteria.",
      whyItMatters:
        "Whale-level characteristics can strengthen a smart-money profile, but they are not required for a wallet to demonstrate experienced or strategic behavior.",
      impact: "neutral",
      confidence: whale.evidenceConfidence,
      severity: "low",
      evidenceRecordIds: [
        "whale-assessment",
        "smart-money-assessment",
      ],
      limitations: [
        "A wallet can demonstrate skilled behavior without holding a whale-sized portfolio.",
        "Incomplete USD valuation may limit the accuracy of the wallet-size classification.",
      ],
    });
  }

  if (
    trust.trustLevel === "high" ||
    trust.trustLevel === "very_high"
  ) {
    positiveInsights.push({
      id: "strong-smart-money-trust",
      title: "Strong Trust Indicators",
      finding:
        `The wallet currently has a ${trust.trustLevel} trust classification.`,
      whyItMatters:
        "Stronger trust indicators provide more reassuring context when interpreting the wallet's activity, portfolio behavior, and smart-money characteristics.",
      impact: "positive",
      confidence: trust.evidenceConfidence,
      severity: "high",
      evidenceRecordIds: [
        "smart-money-assessment",
      ],
      limitations: [
        "Trust scoring does not guarantee that the wallet is safe, legitimate, profitable, or free from undiscovered exposure.",
        "The result is limited to the connected evidence sources and current analytical rules.",
      ],
    });
  } else if (trust.trustLevel === "medium") {
    positiveInsights.push({
      id: "moderate-smart-money-trust",
      title: "Moderate Trust Indicators",
      finding:
        "The wallet currently has a medium trust classification.",
      whyItMatters:
        "Moderate trust indicators provide some reassuring context, although information gaps prevent a stronger assessment.",
      impact: "positive",
      confidence: trust.evidenceConfidence,
      severity: "medium",
      evidenceRecordIds: [
        "smart-money-assessment",
      ],
      limitations: [
        "A medium trust classification does not establish that the wallet is safe or professionally managed.",
        "Missing funding, exposure, relationship, or identity information may affect the result.",
      ],
    });
  } else {
    negativeInsights.push({
      id: "limited-smart-money-trust",
      title: "Limited Trust Indicators",
      finding:
        `The wallet currently has a ${trust.trustLevel} trust classification.`,
      whyItMatters:
        "Weak trust indicators reduce confidence that the wallet's apparent experience or activity should be interpreted positively.",
      impact: "negative",
      confidence: trust.evidenceConfidence,
      severity: "high",
      evidenceRecordIds: [
        "smart-money-assessment",
      ],
      limitations: [
        "Limited trust evidence may result from missing information rather than confirmed harmful activity.",
        "Trust analysis is restricted to the connected evidence sources and analyzed blockchain data.",
      ],
    });
  }

  if (
    whale.estimatedPortfolioUsdValue === null ||
    whale.estimatedPortfolioUsdValue === undefined
  ) {
    neutralInsights.push({
      id: "smart-money-usd-valuation-unavailable",
      title: "USD Portfolio Valuation Unavailable",
      finding:
        "The wallet's complete portfolio value could not be reliably converted into USD.",
      whyItMatters:
        "Reliable USD valuation helps distinguish meaningful capital deployment from token balances that may have little liquidity or monetary value.",
      impact: "neutral",
      confidence: "high",
      severity: "high",
      evidenceRecordIds: [
        "portfolio-summary",
        "whale-assessment",
        "smart-money-assessment",
      ],
      limitations: [
        "Some detected tokens may not have supported or sufficiently reliable market prices.",
        "The smart-money assessment therefore relies more heavily on indirect indicators such as age, activity, DeFi usage, diversity, whale status, and trust.",
      ],
    });
  }

  return {
    isSmartMoneyCandidate:
      level === "medium" || level === "high",

    smartMoneyScore,

    displayScore:
      `${(smartMoneyScore / 10).toFixed(1)} / 10`,

    level,

    evidenceConfidence:
      confidenceAnalysis.level,

    confidenceAnalysis,

    confidence,

    profile,

    positiveSignals,

    limitations,

    investorExplanation,

    investorInsights: {
      positive: positiveInsights,
      neutral: neutralInsights,
      negative: negativeInsights,
    },
  };
}

function buildInvestorSmartMoneySummary(
  level: WalletSmartMoneySummary["level"],
  profile: WalletSmartMoneySummary["profile"],
  smartMoneyScore: number,
): string {
  const profileName = formatProfileName(profile);

  if (level === "high") {
    return (
      `This wallet shows strong smart-money characteristics ` +
      `with a ${profileName} profile and an internal smart-money ` +
      `score of ${smartMoneyScore} out of 100. Multiple behavioral, ` +
      `portfolio, activity, and experience indicators support the classification.`
    );
  }

  if (level === "medium") {
    return (
      `This wallet shows meaningful smart-money characteristics ` +
      `with a ${profileName} profile and an internal smart-money ` +
      `score of ${smartMoneyScore} out of 100. Several positive ` +
      `indicators were identified, although some limitations prevent ` +
      `a stronger classification.`
    );
  }

  if (level === "low") {
    return (
      `This wallet shows limited smart-money characteristics ` +
      `with a ${profileName} profile and an internal smart-money ` +
      `score of ${smartMoneyScore} out of 100. Some relevant signals ` +
      `were identified, but the available evidence does not support ` +
      `a medium or high classification.`
    );
  }

  return (
    `This wallet does not currently show sufficient evidence for ` +
    `a smart-money classification. Its internal smart-money score ` +
    `is ${smartMoneyScore} out of 100, and the available indicators ` +
    `are too limited to support a stronger profile.`
  );
}

function buildSmartMoneyExplanation(
  age: WalletAgeSummary,
  activity: WalletActivitySummary,
  defi: WalletDeFiSummary,
  portfolio: WalletPortfolioSummary,
  whale: WalletWhaleSummary,
  trust: WalletTrustSummary,
): string[] {
  const explanation: string[] = [];

  if (age.classification === "veteran") {
    explanation.push(
      "The wallet has a long blockchain history, which provides stronger evidence for evaluating persistent investment and activity patterns.",
    );
  } else if (
    age.classification === "established"
  ) {
    explanation.push(
      "The wallet has an established blockchain history, which contributes positively to the smart-money assessment.",
    );
  } else {
    explanation.push(
      "The wallet does not currently provide a long enough history to strongly support an experience-based classification.",
    );
  }

  if (activity.activityLevel === "high") {
    explanation.push(
      "The wallet shows high recent blockchain activity, which may indicate active portfolio management, trading, or protocol participation.",
    );
  } else if (
    activity.activityLevel === "medium"
  ) {
    explanation.push(
      "The wallet shows a moderate level of recent blockchain activity, providing current behavioral evidence.",
    );
  } else {
    explanation.push(
      "Limited recent activity reduces the amount of current behavioral evidence available to the model.",
    );
  }

  if (
    defi.profile === "active_defi_user" ||
    defi.profile === "power_user"
  ) {
    explanation.push(
      "The wallet interacts with recognized DeFi protocols, which supports an active on-chain participant profile.",
    );
  } else {
    explanation.push(
      "Limited recognized DeFi activity was found in the analyzed transaction sample.",
    );
  }

  if (portfolio.diversityLevel === "high") {
    explanation.push(
      "The wallet has high portfolio diversity, which supports evidence of broad market participation.",
    );
  } else if (
    portfolio.diversityLevel === "medium"
  ) {
    explanation.push(
      "The wallet has medium portfolio diversity, which contributes positively to its market-participation profile.",
    );
  } else {
    explanation.push(
      "Limited portfolio diversity provides less evidence of broad allocation or active portfolio management.",
    );
  }

  if (whale.isWhale) {
    explanation.push(
      `The wallet has ${whale.whaleLevel} whale-level characteristics, which contribute positively to the smart-money score.`,
    );
  } else {
    explanation.push(
      "The wallet does not currently meet the model's whale-candidate criteria.",
    );
  }

  if (
    trust.trustLevel === "high" ||
    trust.trustLevel === "very_high"
  ) {
    explanation.push(
      "The wallet has strong trust indicators, providing more reassuring context for the smart-money classification.",
    );
  } else if (trust.trustLevel === "medium") {
    explanation.push(
      "The wallet has moderate trust indicators, although some information gaps remain.",
    );
  } else {
    explanation.push(
      "Limited trust indicators reduce confidence in interpreting the wallet's activity as smart-money behavior.",
    );
  }

  return explanation;
}

function formatProfileName(
  profile:
    | WalletSmartMoneySummary["profile"]
    | WalletDeFiSummary["profile"],
): string {
  return profile
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) =>
      character.toUpperCase(),
    );
}
