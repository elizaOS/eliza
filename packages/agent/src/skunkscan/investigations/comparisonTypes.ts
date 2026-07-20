/**
 * Shared comparison models used by all investor timeline comparators.
 *
 * Comparators should focus only on detecting and describing measurable
 * differences between two investigations.
 *
 * Presentation-specific timeline models can later transform these results
 * into investor-friendly report sections.
 */

export type ComparisonMetricValue =
  | string
  | number
  | boolean
  | null;

export type ComparisonDirection =
  | "increased"
  | "decreased"
  | "unchanged"
  | "appeared"
  | "disappeared"
  | "changed"
  | "unknown";

export type ComparisonImpact =
  | "positive"
  | "negative"
  | "neutral"
  | "informational";

export type ComparisonSeverity =
  | "informational"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type ComparisonConfidenceLevel =
  | "low"
  | "medium"
  | "high"
  | "unknown";

export type ComparisonCategory =
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
  | "other";

/**
 * A single fact or signal supporting a comparison result.
 */
export interface ComparisonEvidence {
  id: string;

  label: string;

  description: string;

  previousValue?: ComparisonMetricValue;

  currentValue?: ComparisonMetricValue;

  source?: string;

  observedAt?: string;
}

/**
 * Confidence attached to a comparison result.
 *
 * This describes confidence in the available evidence and comparison,
 * not confidence in future behavior or investment outcomes.
 */
export interface ComparisonConfidence {
  score?: number | null;

  level: ComparisonConfidenceLevel;

  explanation: string;

  factors: string[];

  limitations: string[];
}

/**
 * Raw structured result returned by an individual comparator.
 *
 * This model contains:
 * - what changed
 * - how much it changed
 * - supporting evidence
 * - confidence
 * - neutral interpretation
 *
 * It must not contain financial advice or instructions to buy, sell,
 * hold, avoid, or interact with any wallet or asset.
 */
export interface ComparisonResult {
  id: string;

  category: ComparisonCategory;

  metric: string;

  title: string;

  direction: ComparisonDirection;

  impact: ComparisonImpact;

  severity: ComparisonSeverity;

  previousValue?: ComparisonMetricValue;

  currentValue?: ComparisonMetricValue;

  absoluteChange?: number | null;

  percentageChange?: number | null;

  summary: string;

  explanation: string;

  investorInterpretation: string;

  evidence: ComparisonEvidence[];

  confidence: ComparisonConfidence;

  limitations: string[];

  detectedAt: string;
}

/**
 * Output returned by a comparator module.
 *
 * A comparator may return no results when:
 * - the required data is unavailable
 * - the compared values are unchanged
 * - no meaningful difference is detected
 */
export interface ComparatorOutput {
  comparator: string;

  category: ComparisonCategory;

  results: ComparisonResult[];

  comparedAt: string;

  dataAvailable: boolean;

  limitations: string[];
}
