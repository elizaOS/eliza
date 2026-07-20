import {
  InvestorWalletChange,
  InvestorWalletChangeReport,
} from "./timelineTypes";

import { InvestigationCase } from "./types";

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
      "Comparison report generated.",

    summary:
      "No comparison rules have been executed yet.",

    changes,

    positiveChangeCount: 0,

    negativeChangeCount: 0,

    informationalChangeCount: 0,

    criticalChangeCount: 0,

    keyChanges: [],

    suggestedInvestorAction:
      "Review the observed changes and perform your own due diligence before making investment decisions.",

    limitations: [
      "Comparison rules have not yet been implemented.",
    ],
  };
}
