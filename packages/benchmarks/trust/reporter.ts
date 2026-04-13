/**
 * Reporter for Trust Security Benchmark results.
 * Formats results as a readable table.
 */

import type { BenchmarkResult, CategoryScore, DetectionResult, TestCase } from "./types";

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : " ".repeat(len - str.length) + str;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatReport(
  result: BenchmarkResult,
  handlerName: string,
  corpus: TestCase[],
  detections: DetectionResult[],
): string {
  const lines: string[] = [];
  const detMap = new Map(detections.map((d) => [d.testId, d]));

  lines.push("");
  lines.push("=".repeat(72));
  lines.push(`  Trust Security Benchmark -- ${handlerName}`);
  lines.push(`  ${new Date(result.timestamp).toISOString()}`);
  lines.push("=".repeat(72));
  lines.push("");

  // Category summary table
  lines.push(
    padRight("Category", 22) +
      padLeft("TP", 5) +
      padLeft("FP", 5) +
      padLeft("FN", 5) +
      padLeft("TN", 5) +
      padLeft("Prec", 8) +
      padLeft("Recall", 8) +
      padLeft("F1", 8),
  );
  lines.push("-".repeat(66));

  for (const cat of result.categories) {
    lines.push(
      padRight(cat.category, 22) +
        padLeft(String(cat.truePositives), 5) +
        padLeft(String(cat.falsePositives), 5) +
        padLeft(String(cat.falseNegatives), 5) +
        padLeft(String(cat.trueNegatives), 5) +
        padLeft(pct(cat.precision), 8) +
        padLeft(pct(cat.recall), 8) +
        padLeft(pct(cat.f1), 8),
    );
  }

  lines.push("-".repeat(66));
  lines.push("");
  lines.push(`  Overall Macro F1:     ${pct(result.overallF1)}`);
  lines.push(`  False Positive Rate:  ${pct(result.falsePositiveRate)}`);
  lines.push(`  Total Test Cases:     ${result.totalTests}`);
  lines.push("");

  // Detailed failures
  const failures: string[] = [];
  for (const tc of corpus) {
    const det = detMap.get(tc.id);
    if (!det) continue;

    const shouldDetect = tc.expectedMalicious;
    const wasDetected = det.detected;

    if (shouldDetect && !wasDetected) {
      failures.push(
        `  MISS  [${tc.id}] ${tc.description} (conf: ${det.confidence.toFixed(2)})`,
      );
    } else if (!shouldDetect && wasDetected) {
      failures.push(
        `  FP    [${tc.id}] ${tc.description} (conf: ${det.confidence.toFixed(2)})`,
      );
    }
  }

  if (failures.length > 0) {
    lines.push("Failures:");
    lines.push("-".repeat(72));
    lines.push(...failures);
    lines.push("");
  } else {
    lines.push("No failures -- perfect score!");
    lines.push("");
  }

  lines.push("=".repeat(72));

  return lines.join("\n");
}
