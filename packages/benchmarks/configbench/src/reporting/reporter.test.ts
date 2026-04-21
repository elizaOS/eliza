import { describe, it, expect } from "vitest";
import { writeJsonResults, writeMarkdownReport } from "./reporter.js";
import type { BenchmarkResults } from "../types.js";
import { readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeResults(): BenchmarkResults {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    totalScenarios: 2,
    handlers: [{
      handlerName: "TestHandler",
      overallScore: 75.5,
      securityScore: 100,
      capabilityScore: 60.2,
      categories: [{
        category: "secrets-crud",
        scenarioCount: 2,
        passedCount: 1,
        averageScore: 0.755,
        securityViolations: 0,
      }],
      scenarios: [
        {
          scenarioId: "x-01", scenarioName: "Test One", category: "secrets-crud",
          passed: true, score: 1.0, securityViolation: false, latencyMs: 5,
          checks: [{ name: "check1", passed: true, expected: "yes", actual: "yes", severity: "critical" }],
          traces: ["trace1"],
        },
        {
          scenarioId: "x-02", scenarioName: "Test Two", category: "secrets-crud",
          passed: false, score: 0, securityViolation: true, latencyMs: 3,
          checks: [{ name: "check2", passed: false, expected: "no leak", actual: "leaked", severity: "critical" }],
          traces: ["trace2"],
        },
      ],
      totalTimeMs: 8,
    }],
    validationPassed: true,
  };
}

describe("writeJsonResults", () => {
  const dir = join(tmpdir(), `configbench-test-${Date.now()}`);

  it("writes valid JSON with all fields", () => {
    const results = makeResults();
    const filepath = writeJsonResults(results, dir);
    expect(existsSync(filepath)).toBe(true);

    const parsed = JSON.parse(readFileSync(filepath, "utf8"));
    expect(parsed.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.totalScenarios).toBe(2);
    expect(parsed.validationPassed).toBe(true);
    expect(parsed.handlers).toHaveLength(1);
    expect(parsed.handlers[0].handlerName).toBe("TestHandler");
    expect(parsed.handlers[0].overallScore).toBe(75.5);
    expect(parsed.handlers[0].scenarios).toHaveLength(2);
    expect(parsed.handlers[0].scenarios[0].checks[0].name).toBe("check1");
    expect(parsed.handlers[0].scenarios[1].securityViolation).toBe(true);

    rmSync(dir, { recursive: true });
  });

  it("creates the output directory if it doesn't exist", () => {
    const nested = join(dir, "deep", "nested");
    const filepath = writeJsonResults(makeResults(), nested);
    expect(existsSync(filepath)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("writeMarkdownReport", () => {
  const dir = join(tmpdir(), `configbench-test-md-${Date.now()}`);

  it("writes a markdown file with handler comparison table", () => {
    const filepath = writeMarkdownReport(makeResults(), dir);
    expect(existsSync(filepath)).toBe(true);

    const content = readFileSync(filepath, "utf8");
    expect(content).toContain("# ConfigBench Results");
    expect(content).toContain("**Date:** 2026-01-01T00:00:00.000Z");
    expect(content).toContain("**Total Scenarios:** 2");
    expect(content).toContain("PASSED");
    expect(content).toContain("TestHandler");
    expect(content).toContain("75.5%");
    expect(content).toContain("Test One");
    expect(content).toContain("Test Two");
    expect(content).toContain("SECURITY VIOLATION");
    expect(content).toContain("[CRITICAL]");

    rmSync(dir, { recursive: true });
  });
});
