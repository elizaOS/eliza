import { InvestorEvidenceInsight } from "./evidenceInsight";

export type InvestorEvidenceCollection = {
  positive: InvestorEvidenceInsight[];

  neutral: InvestorEvidenceInsight[];

  negative: InvestorEvidenceInsight[];
};
