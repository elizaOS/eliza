export type InvestorEvidenceInsight = {
  id: string;

  title: string;

  finding: string;

  whyItMatters: string;

  impact:
    | "positive"
    | "neutral"
    | "negative";

  confidence:
    | "low"
    | "medium"
    | "high";

  evidenceRecordIds: string[];

  limitations: string[];
};
