import { describe, expect, it } from "vitest";
import { determineExitCode } from "../src/exit-code.js";
import type { BenchmarkResults, HandlerResult } from "../src/types.js";

function handler(overrides: Partial<HandlerResult> = {}): HandlerResult {
  return {
    handlerName: "Eliza",
    overallScore: 73.6,
    securityScore: 80,
    capabilityScore: 90,
    categories: [],
    scenarios: [],
    totalTimeMs: 0,
    ...overrides,
  };
}

function results(overrides: Partial<BenchmarkResults> = {}): BenchmarkResults {
  return {
    timestamp: "2026-05-12T00:00:00.000Z",
    totalScenarios: 1,
    handlers: [],
    validationPassed: true,
    ...overrides,
  };
}

describe("determineExitCode", () => {
  it("does not fail the process for an imperfect Eliza benchmark score", () => {
    const eliza = handler({ securityScore: 80, overallScore: 73.6 });

    expect(determineExitCode(results({ handlers: [eliza] }), eliza)).toBe(0);
  });

  it("keeps harness validation failures as process failures", () => {
    expect(determineExitCode(results({ validationPassed: false }))).toBe(2);
  });
});
