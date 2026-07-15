import {
  InvestorEvidenceInsight,
} from "./evidenceInsight";

export function createInvestorInsight(
  insight: InvestorEvidenceInsight,
): InvestorEvidenceInsight {
  return {
    ...insight,

    limitations:
      insight.limitations ?? [],

    evidenceRecordIds:
      insight.evidenceRecordIds ?? [],
  };
}
