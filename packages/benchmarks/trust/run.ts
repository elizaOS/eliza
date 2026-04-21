#!/usr/bin/env bun
/**
 * Trust Security Benchmark Runner
 *
 * Usage: bun run benchmarks/trust/run.ts [--handler oracle]
 *
 * Runs the adversarial test corpus against a handler and reports
 * precision, recall, F1 per category plus overall metrics.
 */

import { TEST_CORPUS } from "./corpus";
import { perfectHandler } from "./handlers/perfect";
import { formatReport } from "./reporter";
import { scoreResults } from "./scorer";
import type { DetectionResult, TrustBenchmarkHandler } from "./types";

// ── Handler registry ───────────────────────────────────────────────────────

const HANDLERS: Record<string, TrustBenchmarkHandler> = {
  oracle: perfectHandler,
};

// ── Runner ─────────────────────────────────────────────────────────────────

async function runBenchmark(handler: TrustBenchmarkHandler): Promise<DetectionResult[]> {
  const results: DetectionResult[] = [];

  for (const testCase of TEST_CORPUS) {
    let detection: { detected: boolean; confidence: number };

    switch (testCase.category) {
      case "prompt_injection":
        detection = await handler.detectInjection(testCase.input);
        break;
      case "social_engineering":
        detection = await handler.detectSocialEngineering(testCase.input);
        break;
      case "impersonation":
        detection = await handler.detectImpersonation(
          testCase.input,
          testCase.existingUsers ?? [],
        );
        break;
      case "credential_theft":
        detection = await handler.detectCredentialTheft(testCase.input);
        break;
      case "benign":
        // For benign cases, run through ALL detectors and flag if ANY fires
        const [inj, se, cred] = await Promise.all([
          handler.detectInjection(testCase.input),
          handler.detectSocialEngineering(testCase.input),
          handler.detectCredentialTheft(testCase.input),
        ]);
        detection = {
          detected: inj.detected || se.detected || cred.detected,
          confidence: Math.max(inj.confidence, se.confidence, cred.confidence),
        };
        break;
      default:
        detection = { detected: false, confidence: 0 };
    }

    results.push({
      testId: testCase.id,
      detected: detection.detected,
      confidence: detection.confidence,
      detectedType: detection.detected ? testCase.category : undefined,
    });
  }

  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const handlerName = process.argv.includes("--handler")
    ? process.argv[process.argv.indexOf("--handler") + 1]
    : "oracle";

  const handler = HANDLERS[handlerName];
  if (!handler) {
    console.error(
      `Unknown handler: "${handlerName}". Available: ${Object.keys(HANDLERS).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`Running trust benchmark with handler: ${handler.name}`);
  console.log(`Test corpus: ${TEST_CORPUS.length} cases`);
  console.log("");

  const detections = await runBenchmark(handler);
  const result = scoreResults(TEST_CORPUS, detections);
  const report = formatReport(result, handler.name, TEST_CORPUS, detections);

  console.log(report);

  // Write JSON results
  const resultsPath = new URL("./results.json", import.meta.url).pathname;
  await Bun.write(resultsPath, JSON.stringify(result, null, 2));
  console.log(`Results written to ${resultsPath}`);

  // Exit code based on overall quality
  if (result.overallF1 < 0.5) {
    console.log("\nWARNING: Overall F1 below 50% threshold");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
