/**
 * SkunkScanAI Investor Timeline
 *
 * Investor-focused models for comparing two wallet investigations.
 *
 * These models are designed to answer:
 * - What changed?
 * - Is the wallet becoming safer or riskier?
 * - Did its portfolio, activity or behavior change?
 * - Does the investor need to review the wallet?
 */

export type InvestorChangeDirection =
  | "increased"
  | "decreased"
  | "unchanged"
  | "appeared"
  | "disappeared"
  | "changed"
  | "unknown";

export type InvestorChangeImpact =
  | "positive"
  | "negative"
  | "neutral"
  | "informational";

export type InvestorChangeSeverity =
  | "informational"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type InvestorChangeCategory =
  | "risk"
  | "trust"
  | "portfolio"
  | "whale"
  | "activity"
  | "funding"
  | "behavior"
  | "exposure"
  | "relationships"
  | "compliance"
  | "smart_money"
  | "transaction_risk"
  | "recommendation"
  | "other";

/**
 * A single investor-relevant change between two wallet scans.
 */
export interface InvestorWalletChange {
  id: string;

  category: InvestorChangeCategory;

  title: string;

  description: string;

  direction: InvestorChangeDirection;

  impact: InvestorChangeImpact;

  severity: InvestorChangeSeverity;

  previousValue?: string | number | boolean | null;

  currentValue?: string | number | boolean | null;

  absoluteChange?: number | null;

  percentageChange?: number | null;

  /**
   * Simple investor-facing explanation of why this change matters.
   */
  investorMeaning: string;

  /**
   * Practical action the investor may consider.
   */
  suggestedAction?: string;

  detectedAt: string;
}

/**
 * High-level classification of how the wallet changed.
 */
export type InvestorWalletTrend =
  | "improving"
  | "stable"
  | "mixed"
  | "deteriorating"
  | "insufficient_data";

/**
 * Overall urgency of the change report.
 */
export type InvestorTimelineUrgency =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "critical";

/**
 * Comparison between two completed wallet investigations.
 */
export interface InvestorWalletChangeReport {
  reportId: string;

  chain: string;

  address: string;

  previousInvestigationId: string;

  currentInvestigationId: string;

  previousScanAt: string;

  currentScanAt: string;

  generatedAt: string;

  trend: InvestorWalletTrend;

  urgency: InvestorTimelineUrgency;

  headline: string;

  summary: string;

  changes: InvestorWalletChange[];

  positiveChangeCount: number;

  negativeChangeCount: number;

  informationalChangeCount: number;

  criticalChangeCount: number;

  /**
   * Most important changes shown first to the investor.
   */
  keyChanges: InvestorWalletChange[];

   /**
   * Plain-language interpretation of the findings.
   *
   * This explains what the observed changes mean without making
   * recommendations or providing financial advice.
   */
  investorInterpretation: string;

  limitations: string[];
}

/**
 * Lightweight timeline entry displayed in a wallet history screen.
 */
export interface InvestorWalletTimelineEntry {
  investigationId: string;

  chain: string;

  address: string;

  scannedAt: string;

  riskScore?: number | null;

  trustScore?: number | null;

  portfolioUsdValue?: number | null;

  whaleScore?: number | null;

  recommendation?: string | null;

  changeReportId?: string | null;

  trend?: InvestorWalletTrend;

  urgency?: InvestorTimelineUrgency;
}
