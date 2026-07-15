export type InvestorExplanation = {
  summary: string;

  whyThisAssessment: string[];

  whatReducedConfidence: string[];

  evidenceStrength:
    | "limited"
    | "moderate"
    | "strong";

  informationGaps: string[];
};
