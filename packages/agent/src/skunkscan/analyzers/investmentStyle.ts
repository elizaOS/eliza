import {
  WalletAlphaSummary,
  WalletConvictionSummary,
  WalletDeFiSummary,
  WalletInvestmentStyleSummary,
  WalletPortfolioSummary,
  WalletSmartMoneySummary,
  WalletStrategySummary,
  WalletWhaleSummary,
} from "../types";

type InvestmentStyleInput = {
  strategy: WalletStrategySummary;
  smartMoney: WalletSmartMoneySummary;
  conviction: WalletConvictionSummary;
  alpha: WalletAlphaSummary;
  portfolio: WalletPortfolioSummary;
  whale: WalletWhaleSummary;
  defi: WalletDeFiSummary;
};

export function analyzeInvestmentStyle(
  input: InvestmentStyleInput,
): WalletInvestmentStyleSummary {

  const supportingSignals: string[] = [];
  const conflictingSignals: string[] = [];
  const limitations: string[] = [];

  let style:
    | "long_term_investor"
    | "active_trader"
    | "swing_trader"
    | "momentum_trader"
    | "accumulator"
    | "defi_investor"
    | "yield_farmer"
    | "meme_coin_trader"
    | "whale_investor"
    | "passive_holder"
    | "diversified_investor"
    | "mixed" = "mixed";

  // Each of the 5 checks below unconditionally overwrites `style` if true -
  // last match wins, not a scored priority. matchedStyleLabels tracks every
  // condition that matched (not just the final winner), so when more than
  // one is true simultaneously, the ones that got silently overwritten
  // become real conflictingSignals instead of disappearing - a wallet that
  // is simultaneously whale-sized AND highly diversified genuinely has
  // conflicting classification evidence, not a clean single answer.
  const matchedStyleLabels: { style: string; label: string }[] = [];

  if (input.whale.isWhale) {
    style = "whale_investor";
    supportingSignals.push("Whale characteristics detected.");
    matchedStyleLabels.push({ style: "whale_investor", label: "Whale characteristics" });
  }

  if (input.strategy.primaryStrategy === "holding") {
    style = "long_term_investor";
    supportingSignals.push("Holding strategy detected.");
    matchedStyleLabels.push({ style: "long_term_investor", label: "Holding strategy" });
  }

  if (input.strategy.primaryStrategy === "accumulating") {
    style = "accumulator";
    supportingSignals.push("Accumulation strategy detected.");
    matchedStyleLabels.push({ style: "accumulator", label: "Accumulation strategy" });
  }

  if (input.defi.protocolCount > 0) {
    style = "defi_investor";
    supportingSignals.push("Recognized DeFi participation.");
    matchedStyleLabels.push({ style: "defi_investor", label: "DeFi participation" });
  }

  if (input.portfolio.diversityLevel === "high") {
    style = "diversified_investor";
    supportingSignals.push("Highly diversified portfolio.");
    matchedStyleLabels.push({ style: "diversified_investor", label: "High portfolio diversity" });
  }

  const overriddenStyleMatches = matchedStyleLabels.filter(
    (match) => match.style !== style,
  );

  if (overriddenStyleMatches.length > 0) {
    conflictingSignals.push(
      `This wallet also shows ${overriddenStyleMatches.map((match) => match.label.toLowerCase()).join(", ")} - equally real evidence for a different style than "${style.replaceAll("_", " ")}", which was chosen only because it was the last matching condition checked.`,
    );
  }

  if (
    input.conviction.convictionLevel === "low" ||
    input.conviction.convictionLevel === "very_low"
  ) {
    conflictingSignals.push(
      "Low measured conviction contradicts a confidently-assigned style label.",
    );
  }

  if (
    input.smartMoney.level === "none" &&
    style !== "mixed"
  ) {
    conflictingSignals.push(
      "No smart-money characteristics were detected, despite a specific style classification.",
    );
  }

  if (style === "mixed") {
    limitations.push(
      "No single investment style pattern was distinctly identified from the available evidence - none of the whale, strategy, DeFi, or diversification conditions matched.",
    );
  }

  let confidence: "low" | "medium" | "high";

  if (input.alpha.alphaScore >= 75) {
    confidence = "high";
  } else if (input.alpha.alphaScore >= 45) {
    confidence = "medium";
  } else {
    confidence = "low";
    limitations.push(
      "Confidence in this style classification is low based on the wallet's overall Alpha Score.",
    );
  }

  return {
    style,
    confidence,
    evidenceConfidence: confidence,
    confidenceAnalysis: {
      rawScore:
        input.alpha.alphaScore,
      maxScore: 100,
      displayScore:
        `${(input.alpha.alphaScore / 10).toFixed(1)} / 10`,
      maxDisplayScore: 10,
      level: confidence,
      reasons: supportingSignals,
    },
    investorHeadline:
      `Investment Style: ${style.replaceAll("_", " ")}`,
    investorSummary:
      "Investment Style summarizes how this wallet typically participates in the market using blockchain evidence.",
    investorTakeaway:
      "This classification helps investors understand the wallet's overall investment behavior rather than a single transaction.",
    styleDescription:
      style.replaceAll("_", " "),
    supportingSignals,
    conflictingSignals,
    limitations,
  };
}
