import {
  InvestorWalletChange,
  InvestorWalletChangeReport,
} from "./timelineTypes";

import { InvestigationCase } from "./types";

import { compareRiskScore } from "./comparators/riskComparison";

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 10)}`;
}

export interface BuildTimelineInput {
  previous: InvestigationCase;
  current: InvestigationCase;
}

export function buildInvestorTimeline(
  input: BuildTimelineInput,
): InvestorWalletChangeReport {
  
  const changes: InvestorWalletChange[] = [];

const riskComparison = compareRiskScore(
  input.previous,
  input.current,
);

for (const result of riskComparison.results) {
  changes.push({
    id: result.id,

    category: result.category,

    title: result.title,

    description: result.summary,

    direction: result.direction,

    impact: result.impact,

    severity: result.severity,

    previousValue: result.previousValue,

    currentValue: result.currentValue,

    absoluteChange: result.absoluteChange,

    percentageChange: result.percentageChange,

    investorMeaning:
      result.investorInterpretation,

    detectedAt: result.detectedAt,
  });
}

  return {
    reportId: generateId("timeline"),

    chain:
      input.current.subjects[0]?.chain ?? "unknown",

    address:
      input.current.subjects[0]?.identifier ?? "unknown",

    previousInvestigationId: input.previous.id,

    currentInvestigationId: input.current.id,

    previousScanAt: input.previous.createdAt,

    currentScanAt: input.current.createdAt,

    generatedAt: new Date().toISOString(),

    trend: "insufficient_data",

    urgency: "none",

    headline:
      changes.length > 0
        ? "Changes were detected between the two investigations."
        : "No significant changes were detected.",

    summary:
      changes.length > 0
        ? `The comparison engine detected ${changes.length} investor-relevant change(s).`
        : "The comparison engine did not detect any investor-relevant changes.",

    changes,

    positiveChangeCount: changes.filter(
      (change) => change.impact === "positive",
    ).length,

    negativeChangeCount: changes.filter(
      (change) => change.impact === "negative",
    ).length,

    informationalChangeCount: changes.filter(
      (change) => change.impact === "informational",
    ).length,

    criticalChangeCount: changes.filter(
      (change) => change.severity === "critical",
    ).length,

    keyChanges: changes.slice(0, 5),

    investorInterpretation:
      "This report summarises observed changes between the two investigations. It explains the observed on-chain evidence and how the wallet has changed over time. The findings are provided for informational purposes and should not be interpreted as financial, legal, or investment advice.",

    limitations: [
      "The comparison currently evaluates risk score changes only.",
      "The findings are based on the on-chain information available during the two investigations.",
      "Wallet ownership, intent, and off-chain activity cannot be determined from blockchain data alone.",
    ],
  };
}
