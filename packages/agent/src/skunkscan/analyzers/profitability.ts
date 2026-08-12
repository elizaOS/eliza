import {
  WalletAlphaSummary,
  WalletConvictionSummary,
  WalletPortfolioSummary,
  WalletProfitabilitySummary,
  WalletSmartMoneySummary,
  WalletStrategySummary,
  WalletTrustSummary,
} from "../types";

type ProfitabilityInput = {
  alpha: WalletAlphaSummary;
  conviction: WalletConvictionSummary;
  strategy: WalletStrategySummary;
  trust: WalletTrustSummary;
  smartMoney: WalletSmartMoneySummary;
  portfolio: WalletPortfolioSummary;
};

export function analyzeWalletProfitability(
  input: ProfitabilityInput,
): WalletProfitabilitySummary {
  // profitabilityScore below is a weighted blend of alpha/smartMoney/trust/
  // conviction - not hardcoded, a real computation. But alpha, smartMoney,
  // and conviction all read portfolio.diversityScore/diversityLevel
  // directly (see their own dataCompleteness handling), so when token
  // holdings were truncated/timed out, this blend rests on inputs we
  // already know are unreliable. Short-circuiting here, rather than
  // computing and displaying a number, is what prevents the exact bug this
  // was built to fix: a confident-looking score (e.g. 5.9/10) with no
  // positiveIndicators/negativeIndicators actually backing it.
  if (input.portfolio.dataCompleteness === "incomplete") {
    return {
      profitabilityScore: 0,
      displayScore: "N/A",
      profitabilityLevel: "unknown",
      estimatedProfitability: "unknown",
      confidence: "low",
      evidenceConfidence: "low",
      confidenceAnalysis: {
        rawScore: 0,
        maxScore: 100,
        displayScore: "N/A",
        maxDisplayScore: 10,
        level: "low",
        reasons: [],
      },
      investorHeadline: "Insufficient Data for Profitability",
      investorSummary:
        "Token holdings could not be fully retrieved for this wallet, so a profitability assessment could not be computed.",
      investorTakeaway:
        "This is not a low-profitability finding - it means the underlying portfolio data needed to assess profitability was incomplete (the token-holdings fetch was truncated or timed out).",
      positiveIndicators: [],
      negativeIndicators: [],
      limitations: [
        "Token holdings could not be fully retrieved for this wallet (the fetch was truncated or timed out) - profitability could not be assessed from incomplete portfolio data.",
      ],
    };
  }

  let profitabilityScore = 0;

  // Surfaces the blend's own real inputs' already-computed reasons, rather
  // than reinventing explanation logic - alpha.ts and conviction.ts already
  // expose purpose-built positive/negative pairs (strengths/weaknesses,
  // supportingSignals/conflictingSignals); smartMoney.ts and trust.ts only
  // expose a positive array (their own `limitations` are evidence caveats,
  // not "this reduced the score" statements, so deliberately not folded in
  // here - a different kind of claim). This fixes the common case (a real,
  // confidently-computed score with nothing visibly backing it), not every
  // case - alpha.ts's own strengths/weaknesses are themselves populated by
  // narrow bonus conditions, so a sufficiently "middling on every axis"
  // wallet could still end up with empty indicators here. Not claiming
  // more than this actually delivers.
  const positiveIndicators: string[] = [
    ...input.alpha.strengths,
    ...input.conviction.supportingSignals,
    ...input.smartMoney.positiveSignals,
    ...input.trust.positiveSignals,
  ];
  const negativeIndicators: string[] = [
    ...input.alpha.weaknesses,
    ...input.conviction.conflictingSignals,
  ];
  const limitations: string[] = [];

  profitabilityScore += Math.round(input.alpha.alphaScore * 0.35);
  profitabilityScore += Math.round(input.smartMoney.smartMoneyScore * 0.25);
  profitabilityScore += Math.round(input.trust.trustScore * 0.20);
  profitabilityScore += Math.round(input.conviction.convictionScore * 0.20);

  profitabilityScore = Math.min(100, profitabilityScore);

  if (input.strategy.primaryStrategy === "holding") {
    profitabilityScore += 5;
    positiveIndicators.push("Long-term holding behavior detected.");
  }

  if (input.strategy.primaryStrategy === "accumulating") {
    profitabilityScore += 5;
    positiveIndicators.push("Accumulation behavior detected.");
  }

  if (input.portfolio.diversityLevel === "high") {
    profitabilityScore += 5;
    positiveIndicators.push("High portfolio diversification.");
  }

  profitabilityScore = Math.min(100, profitabilityScore);

  let profitabilityLevel:
    | "unknown"
    | "weak"
    | "limited"
    | "moderate"
    | "strong"
    | "very_strong";

  if (profitabilityScore >= 90) {
    profitabilityLevel = "very_strong";
  } else if (profitabilityScore >= 75) {
    profitabilityLevel = "strong";
  } else if (profitabilityScore >= 55) {
    profitabilityLevel = "moderate";
  } else if (profitabilityScore >= 35) {
    profitabilityLevel = "limited";
  } else if (profitabilityScore > 0) {
    profitabilityLevel = "weak";
  } else {
    profitabilityLevel = "unknown";
  }

  let estimatedProfitability:
    | "unknown"
    | "unlikely"
    | "possible"
    | "likely";

  if (profitabilityScore >= 75) {
    estimatedProfitability = "likely";
  } else if (profitabilityScore >= 45) {
    estimatedProfitability = "possible";
  } else if (profitabilityScore > 0) {
    estimatedProfitability = "unlikely";
  } else {
    estimatedProfitability = "unknown";
  }

  const confidence =
    profitabilityScore >= 70
      ? "high"
      : profitabilityScore >= 40
      ? "medium"
      : "low";

  limitations.push(
    "This assessment estimates profitability characteristics using observable blockchain evidence and should not be interpreted as realized profit or investment returns.",
  );

  return {
    profitabilityScore,
    displayScore: `${(profitabilityScore / 10).toFixed(1)} / 10`,
    profitabilityLevel,
    estimatedProfitability,
    confidence,
    evidenceConfidence: confidence,
    confidenceAnalysis: {
      rawScore: profitabilityScore,
      maxScore: 100,
      displayScore: `${(profitabilityScore / 10).toFixed(1)} / 10`,
      maxDisplayScore: 10,
      level: confidence,
      reasons: positiveIndicators,
    },
    investorHeadline: "Profitability Indicators",
    investorSummary:
      "This score estimates whether the wallet demonstrates characteristics commonly associated with profitable long-term investors.",
    investorTakeaway:
      "The score is evidence-based and does not represent realized profit or financial advice.",
    positiveIndicators,
    negativeIndicators,
    limitations,
  };
}
