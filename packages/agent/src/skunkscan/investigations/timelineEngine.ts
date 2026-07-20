import {
  InvestorWalletChange,
  InvestorWalletChangeReport,
} from "./timelineTypes";

import { InvestigationCase } from "./types";

import { compareRisk } from "./comparators/riskComparator";

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

  changes.push(
    ...compareRisk(
      input.previous,
      input.current,
    ),
  );

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

    suggestedInvestorAction:
      "This report presents observed changes for informational purposes. The interpretation and any resulting decision remain with the user.",

    limitations: [
      "The comparison currently evaluates risk score changes only.",
      "The findings are based on the on-chain information available during the two investigations.",
      "Wallet ownership, intent, and off-chain activity cannot be determined from blockchain data alone.",
    ],
  };
}
