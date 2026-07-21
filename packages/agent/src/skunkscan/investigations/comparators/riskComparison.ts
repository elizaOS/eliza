import {
  ComparatorOutput,
  ComparisonResult,
} from "../comparisonTypes";

import { InvestigationCase } from "../types";

function createId(): string {
  return `comparison_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 10)}`;
}

export function compareRiskScore(
  previous: InvestigationCase,
  current: InvestigationCase,
): ComparatorOutput {

  const previousRisk =
    previous.walletAnalysis?.risk?.score;

  const currentRisk =
    current.walletAnalysis?.risk?.score;

  if (
    typeof previousRisk !== "number" ||
    typeof currentRisk !== "number"
  ) {
    return {
      comparator: "risk",

      category: "risk",

      results: [],

      comparedAt: new Date().toISOString(),

      dataAvailable: false,

      limitations: [
        "Risk score was unavailable in one or both investigations.",
      ],
    };
  }

  if (previousRisk === currentRisk) {
    return {
      comparator: "risk",

      category: "risk",

      results: [],

      comparedAt: new Date().toISOString(),

      dataAvailable: true,

      limitations: [],
    };
  }

  const difference = Number(
    (currentRisk - previousRisk).toFixed(2),
  );

  const result: ComparisonResult = {
    id: createId(),

    category: "risk",

    metric: "risk_score",

    title: "Risk score changed",

    direction:
      difference > 0
        ? "increased"
        : "decreased",

    impact:
      difference > 0
        ? "negative"
        : "positive",

    severity:
      Math.abs(difference) >= 3
        ? "high"
        : Math.abs(difference) >= 1
        ? "medium"
        : "low",

    previousValue: previousRisk,

    currentValue: currentRisk,

    absoluteChange: difference,

    percentageChange:
      previousRisk === 0
        ? null
        : Number(
            (
              (difference / previousRisk) *
              100
            ).toFixed(2),
          ),

    summary:
      `Risk score changed from ${previousRisk.toFixed(
        1,
      )} to ${currentRisk.toFixed(1)}.`,

    explanation:
      "The comparison detected a measurable change in the calculated risk score between the two investigations.",

    investorInterpretation:
      difference > 0
        ? "The available on-chain evidence now produces a higher overall risk score than during the previous investigation."
        : "The available on-chain evidence now produces a lower overall risk score than during the previous investigation.",

    evidence: [
      {
        id: createId(),

        label: "Risk Score",

        description:
          "Comparison of the calculated overall risk score.",

        previousValue: previousRisk,

        currentValue: currentRisk,
      },
    ],

    confidence: {
      score: 9,

      level: "high",

      explanation:
        "Confidence is high because the comparison is based on two completed investigations using the same scoring methodology.",

      factors: [
        "Previous investigation available",
        "Current investigation available",
        "Comparable metric detected",
      ],

      limitations: [
        "Confidence relates to the comparison itself, not future wallet behaviour.",
      ],
    },

    limitations: [
      "This comparison reflects observed on-chain data only.",
      "It does not determine ownership, intent, or future activity.",
    ],

    detectedAt: new Date().toISOString(),
  };

  return {
    comparator: "risk",

    category: "risk",

    results: [result],

    comparedAt: new Date().toISOString(),

    dataAvailable: true,

    limitations: [],
  };
}
