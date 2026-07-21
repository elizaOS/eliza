export type InvestigationResponseVersion = "1.0";

export type InvestigationSectionStatus =
  | "available"
  | "limited"
  | "unavailable"
  | "not_applicable";

export type InvestigationImpact =
  | "positive"
  | "neutral"
  | "negative"
  | "informational";

export type InvestigationSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type InvestigationConfidenceLevel =
  | "low"
  | "medium"
  | "high";

export type InvestigationScoreDirection =
  | "higher_is_better"
  | "higher_is_worse"
  | "context_dependent";

export interface InvestigationScore {
  rawScore: number | null;
  maxRawScore: number | null;
  displayScore: string | null;
  displayMaxScore: number | null;
  level: string | null;
  direction: InvestigationScoreDirection;
}

export interface InvestigationConfidence {
  level: InvestigationConfidenceLevel;
  rawScore: number | null;
  maxRawScore: number | null;
  displayScore: string | null;
  reasons: string[];
}

export interface InvestigationEvidenceReference {
  evidenceRecordId: string;
  description: string;
}

export interface InvestigationFinding {
  id: string;
  title: string;
  finding: string;
  whyItMatters: string;
  impact: InvestigationImpact;
  severity: InvestigationSeverity;
  confidence: InvestigationConfidenceLevel;
  evidence: InvestigationEvidenceReference[];
  limitations: string[];
}

export interface InvestigationExplanation {
  summary: string;
  whyThisAssessment: string[];
  whatReducedConfidence: string[];
}

export interface InvestigationSection {
  id: string;
  title: string;
  status: InvestigationSectionStatus;

  score: InvestigationScore | null;

  verdict: string;
  plainLanguageExplanation: string;

  explanation: InvestigationExplanation;

  findings: InvestigationFinding[];

  evidence: InvestigationEvidenceReference[];

  confidence: InvestigationConfidence;

  investorInterpretation: string;

  limitations: string[];
}

export interface InvestigationResponseMetadata {
  responseVersion: InvestigationResponseVersion;
  generatedAt: string;
  chain: string;
  address: string;
  status: string;
}

export interface InvestigationResponseNotice {
  informationalPurposeOnly: boolean;
  finalDecisionRemainsWithUser: boolean;
  text: string;
}

export interface SkunkScanInvestigationResponseV1 {
  metadata: InvestigationResponseMetadata;

  headline: string;
  overallVerdict: string;
  overallExplanation: string;

  sections: InvestigationSection[];

  informationGaps: string[];

  notice: InvestigationResponseNotice;
}
