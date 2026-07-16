import {
  InvestorEvidenceInsight,
} from "./evidenceInsight";

type InvestorInsightInput =
  Omit<
    InvestorEvidenceInsight,
    | "severity"
    | "limitations"
    | "evidenceRecordIds"
  > & {
    severity?:
      | "low"
      | "medium"
      | "high"
      | "critical";

    limitations?: string[];

    evidenceRecordIds?: string[];
  };

export function createInvestorInsight(
  insight: InvestorInsightInput,
): InvestorEvidenceInsight {
  return {
    ...insight,

    severity:
      insight.severity ?? "low",

    limitations:
      insight.limitations ?? [],

    evidenceRecordIds:
      insight.evidenceRecordIds ?? [],
  };
}
