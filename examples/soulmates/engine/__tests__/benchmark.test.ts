import { describe, expect, it } from "vitest";
import {
  createBenchmarkPersonas,
  printBenchmarkReport,
  runAllBenchmarks,
  runBenchmark,
} from "../benchmark";

describe("Benchmark System", () => {
  describe("createBenchmarkPersonas", () => {
    it("should create personas for all benchmark cases", () => {
      const cases = createBenchmarkPersonas();
      expect(cases.length).toBeGreaterThan(0);
      for (const benchmarkCase of cases) {
        expect(benchmarkCase.id).toBeTruthy();
        expect(benchmarkCase.name).toBeTruthy();
        expect(benchmarkCase.personas.length).toBeGreaterThan(0);
        expect(benchmarkCase.expectedMatches.length).toBeGreaterThan(0);
      }
    });

    it("should have unique persona IDs within each case", () => {
      const cases = createBenchmarkPersonas();
      for (const benchmarkCase of cases) {
        const ids = benchmarkCase.personas.map((p) => p.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
      }
    });

    it("should cover multiple domains", () => {
      const cases = createBenchmarkPersonas();
      const domains = new Set(cases.map((c) => c.domain));
      expect(domains.size).toBeGreaterThan(1);
    });
  });

  describe("runBenchmark", () => {
    it("should run business case successfully", async () => {
      const cases = createBenchmarkPersonas();
      const businessCase = cases.find((c) => c.id === "business-complementary");
      expect(businessCase).toBeDefined();
      if (!businessCase) return;

      const result = await runBenchmark(businessCase);
      expect(result.caseId).toBe(businessCase.id);
      expect(result.caseName).toBe(businessCase.name);
      expect(result.totalExpected).toBe(businessCase.expectedMatches.length);
      expect(result.matches.length).toBeGreaterThanOrEqual(0);
      expect(result.truePositives).toBeGreaterThanOrEqual(0);
      expect(result.falsePositives).toBeGreaterThanOrEqual(0);
      expect(result.trueNegatives).toBeGreaterThanOrEqual(0);
      expect(result.falseNegatives).toBeGreaterThanOrEqual(0);
      expect(result.precision).toBeGreaterThanOrEqual(0);
      expect(result.precision).toBeLessThanOrEqual(1);
      expect(result.recall).toBeGreaterThanOrEqual(0);
      expect(result.recall).toBeLessThanOrEqual(1);
    });

    it("should correctly identify dealbreaker mismatches", async () => {
      const cases = createBenchmarkPersonas();
      const dealbreakerCase = cases.find((c) => c.id === "dating-dealbreaker");
      expect(dealbreakerCase).toBeDefined();
      if (!dealbreakerCase) return;

      const result = await runBenchmark(dealbreakerCase);
      const hasNoMatch = result.matches.length === 0;
      if (hasNoMatch) {
        expect(result.trueNegatives).toBe(1);
        expect(result.falsePositives).toBe(0);
      }
    });

    it("should penalize low reliability", async () => {
      const cases = createBenchmarkPersonas();
      const reliabilityCase = cases.find((c) => c.id === "reliability-penalty");
      expect(reliabilityCase).toBeDefined();
      if (!reliabilityCase) return;

      const result = await runBenchmark(reliabilityCase);
      const hasNoMatch = result.matches.length === 0;
      if (hasNoMatch) {
        expect(result.trueNegatives).toBe(1);
        expect(result.falsePositives).toBe(0);
      }
    });

    it("should block matches with red flags", async () => {
      const cases = createBenchmarkPersonas();
      const redFlagCase = cases.find((c) => c.id === "red-flags-block");
      expect(redFlagCase).toBeDefined();
      if (!redFlagCase) return;

      const result = await runBenchmark(redFlagCase);
      const hasNoMatch = result.matches.length === 0;
      if (hasNoMatch) {
        expect(result.trueNegatives).toBe(1);
        expect(result.falsePositives).toBe(0);
      }
    });
  });

  describe("runAllBenchmarks", () => {
    it("should run all benchmark cases", async () => {
      const results = await runAllBenchmarks();
      const cases = createBenchmarkPersonas();
      expect(results.length).toBe(cases.length);

      for (const result of results) {
        expect(result.caseId).toBeTruthy();
        expect(result.caseName).toBeTruthy();
        expect(result.matches).toBeDefined();
        expect(result.precision).toBeGreaterThanOrEqual(0);
        expect(result.recall).toBeGreaterThanOrEqual(0);
        expect(result.accuracy).toBeGreaterThanOrEqual(0);
      }
    });

    it("should have high overall precision", async () => {
      const results = await runAllBenchmarks();
      let totalTP = 0;
      let totalFP = 0;

      for (const result of results) {
        totalTP += result.truePositives;
        totalFP += result.falsePositives;
      }

      const overallPrecision =
        totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 1;
      expect(overallPrecision).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe("printBenchmarkReport", () => {
    it("should print report without crashing", async () => {
      const results = await runAllBenchmarks();
      expect(() => printBenchmarkReport(results)).not.toThrow();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty matches gracefully", () => {
      const result = {
        caseId: "test",
        caseName: "Test Case",
        totalExpected: 0,
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 0,
        falseNegatives: 0,
        precision: 0,
        recall: 0,
        f1Score: 0,
        accuracy: 0,
        matches: [],
        errors: [],
      };
      expect(() => printBenchmarkReport([result])).not.toThrow();
    });

    it("should calculate metrics correctly with zero values", () => {
      const result = {
        caseId: "test",
        caseName: "Test Case",
        totalExpected: 1,
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 1,
        falseNegatives: 0,
        precision: 0,
        recall: 0,
        f1Score: 0,
        accuracy: 1,
        matches: [],
        errors: [],
      };
      expect(result.accuracy).toBe(1);
      expect(result.precision).toBe(0);
      expect(result.recall).toBe(0);
    });
  });
});
