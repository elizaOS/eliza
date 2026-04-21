/**
 * Scoring functions for the Trust Security Benchmark.
 * Computes precision, recall, F1 per category and overall.
 */

import type {
  BenchmarkResult,
  CategoryScore,
  DetectionResult,
  TestCase,
  ThreatCategory,
} from "./types";

export function scoreResults(
  corpus: TestCase[],
  results: DetectionResult[],
): BenchmarkResult {
  const resultMap = new Map(results.map((r) => [r.testId, r]));

  const categories: ThreatCategory[] = [
    "prompt_injection",
    "social_engineering",
    "impersonation",
    "credential_theft",
    "benign",
  ];

  const categoryScores: CategoryScore[] = categories.map((category) => {
    const casesInCategory = corpus.filter((c) => c.category === category);
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    for (const testCase of casesInCategory) {
      const result = resultMap.get(testCase.id);
      if (!result) {
        // Missing result counts as false negative if expected malicious
        if (testCase.expectedMalicious) fn++;
        else tn++;
        continue;
      }

      if (testCase.expectedMalicious) {
        if (result.detected) tp++;
        else fn++;
      } else {
        if (result.detected) fp++;
        else tn++;
      }
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;

    return {
      category,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      trueNegatives: tn,
      precision,
      recall,
      f1,
      total: casesInCategory.length,
    };
  });

  // Macro-averaged F1 (exclude benign since it has no "true positive" concept)
  const detectCategories = categoryScores.filter(
    (c) => c.category !== "benign",
  );
  const overallF1 =
    detectCategories.length > 0
      ? detectCategories.reduce((sum, c) => sum + c.f1, 0) /
        detectCategories.length
      : 0;

  // False positive rate on benign corpus
  const benignScore = categoryScores.find((c) => c.category === "benign");
  const falsePositiveRate =
    benignScore && benignScore.total > 0
      ? benignScore.falsePositives / benignScore.total
      : 0;

  return {
    categories: categoryScores,
    overallF1,
    falsePositiveRate,
    totalTests: corpus.length,
    timestamp: Date.now(),
  };
}
