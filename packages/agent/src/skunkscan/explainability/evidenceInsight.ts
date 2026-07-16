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

  severity:
  | "low"
  | "medium"
  | "high"
  | "critical";

  evidenceRecordIds: string[];

  limitations: string[];
};
