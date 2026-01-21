import { describe, expect, it } from "vitest";
import { generatePersonas } from "../generator";
import { createDefaultLlmProvider, HeuristicLlmProvider } from "../llm";
import type { DomainMode } from "../types";

describe("HeuristicLlmProvider", () => {
  const now = "2026-01-18T12:00:00.000Z";
  const provider = new HeuristicLlmProvider();

  describe("smallPass", () => {
    it("should rank candidates by compatibility score", async () => {
      const personas = generatePersonas({ seed: 42, count: 5, now });
      const persona = personas[0];
      const candidates = personas.slice(1);

      const result = await provider.smallPass({
        persona,
        candidates,
        domain: "friendship" as DomainMode,
        notes: "Test ranking",
      });

      expect(result.rankedIds).toHaveLength(4);
      expect(
        result.rankedIds.every((id) => candidates.some((c) => c.id === id)),
      ).toBe(true);
      expect(result.notes).toBe("Test ranking");
    });

    it("should handle empty candidate list", async () => {
      const personas = generatePersonas({ seed: 42, count: 1, now });
      const persona = personas[0];

      const result = await provider.smallPass({
        persona,
        candidates: [],
        domain: "dating" as DomainMode,
        notes: "Empty candidates",
      });

      expect(result.rankedIds).toHaveLength(0);
    });

    it("should rank by descending score", async () => {
      const personas = generatePersonas({ seed: 123, count: 10, now });
      const persona = personas[0];
      const candidates = personas.slice(1);

      // Set up candidates with different characteristics for clear ranking
      candidates[0].reliability.score = 0.9;
      candidates[0].profile.feedbackSummary.sentimentScore = 0.8;
      candidates[1].reliability.score = 0.5;
      candidates[1].profile.feedbackSummary.sentimentScore = 0.5;
      candidates[2].reliability.score = 0.3;
      candidates[2].profile.feedbackSummary.sentimentScore = 0.3;

      const result = await provider.smallPass({
        persona,
        candidates,
        domain: "friendship" as DomainMode,
        notes: "Ranking check",
      });

      // First ranked should be the most compatible (highest scores)
      expect(result.rankedIds[0]).toBe(candidates[0].id);
    });
  });

  describe("largePass", () => {
    it("should provide detailed assessment with reasoning", async () => {
      const personas = generatePersonas({ seed: 42, count: 2, now });
      const persona = personas[0];
      const candidate = personas[1];

      const result = await provider.largePass({
        persona,
        candidate,
        domain: "dating" as DomainMode,
        notes: "Detailed assessment",
      });

      expect(result.score).toBeGreaterThanOrEqual(-100);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(Array.isArray(result.positiveReasons)).toBe(true);
      expect(Array.isArray(result.negativeReasons)).toBe(true);
      expect(Array.isArray(result.redFlags)).toBe(true);
      expect(result.notes).toBe("Detailed assessment");
    });

    it("should penalize candidates with red flags", async () => {
      const personas = generatePersonas({ seed: 42, count: 2, now });
      const persona = personas[0];
      const candidate = personas[1];

      // Add red flags
      candidate.profile.feedbackSummary.redFlagTags = [
        "aggressive",
        "inappropriate",
        "unreliable",
      ];

      const result = await provider.largePass({
        persona,
        candidate,
        domain: "friendship" as DomainMode,
        notes: "Red flags",
      });

      expect(result.score).toBeLessThan(50);
      expect(result.redFlags.length).toBeGreaterThan(0);
      expect(result.negativeReasons.length).toBeGreaterThan(0);
    });

    it("should give high scores to highly compatible candidates", async () => {
      const personas = generatePersonas({ seed: 42, count: 2, now });
      const persona = personas[0];
      const candidate = personas[1];

      // Make candidate highly compatible
      candidate.reliability.score = 0.95;
      candidate.profile.feedbackSummary.sentimentScore = 0.9;
      candidate.profile.feedbackSummary.redFlagTags = [];
      candidate.profile.interests = [
        ...persona.profile.interests,
        "hiking",
        "reading",
      ];

      const result = await provider.largePass({
        persona,
        candidate,
        domain: "friendship" as DomainMode,
        notes: "Highly compatible",
      });

      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.positiveReasons.length).toBeGreaterThan(0);
    });

    it("should provide domain-specific scoring for dating", async () => {
      const personas = generatePersonas({ seed: 42, count: 2, now });
      const persona = personas[0];
      const candidate = personas[1];

      // Ensure both have dating profiles
      persona.domains = ["dating"];
      candidate.domains = ["dating"];

      const result = await provider.largePass({
        persona,
        candidate,
        domain: "dating" as DomainMode,
        notes: "Dating scoring",
      });

      expect(result.score).toBeDefined();
      expect(typeof result.score).toBe("number");
    });

    it("should apply harshness penalty to marginal candidates", async () => {
      const personas = generatePersonas({ seed: 42, count: 2, now });
      const persona = personas[0];
      const candidate = personas[1];

      // Make candidate marginal (medium scores)
      candidate.reliability.score = 0.5;
      candidate.profile.feedbackSummary.sentimentScore = 0.5;

      const result = await provider.largePass({
        persona,
        candidate,
        domain: "friendship" as DomainMode,
        notes: "Harshness penalty",
      });

      // Score should be reduced due to harshness penalty
      expect(result.score).toBeLessThan(70);
    });
  });

  describe("createDefaultLlmProvider", () => {
    it("should return a working LlmProvider instance", async () => {
      const provider = createDefaultLlmProvider();
      const personas = generatePersonas({ seed: 42, count: 3, now });

      const smallResult = await provider.smallPass({
        persona: personas[0],
        candidates: personas.slice(1),
        domain: "friendship" as DomainMode,
        notes: "Default provider small pass",
      });

      expect(smallResult.rankedIds).toHaveLength(2);

      const largeResult = await provider.largePass({
        persona: personas[0],
        candidate: personas[1],
        domain: "friendship" as DomainMode,
        notes: "Default provider large pass",
      });

      expect(largeResult.score).toBeDefined();
    });
  });

  describe("Error handling", () => {
    it("should handle personas with minimal data", async () => {
      const personas = generatePersonas({ seed: 42, count: 2, now });
      const persona = personas[0];
      const candidate = personas[1];

      // Strip down candidate data
      candidate.profile.interests = [];
      candidate.profile.feedbackSummary.sentimentScore = 0;

      const result = await provider.largePass({
        persona,
        candidate,
        domain: "general" as DomainMode,
        notes: "Minimal data",
      });

      expect(result.score).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(-100);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("should handle mismatched time zones", async () => {
      const personas = generatePersonas({ seed: 42, count: 2, now });
      const persona = personas[0];
      const candidate = personas[1];

      persona.profile.availability.timeZone = "America/Los_Angeles";
      candidate.profile.availability.timeZone = "Asia/Tokyo";

      const result = await provider.largePass({
        persona,
        candidate,
        domain: "friendship" as DomainMode,
        notes: "Timezone mismatch",
      });

      // Should still return a valid score, but penalized
      expect(result.score).toBeDefined();
      expect(result.negativeReasons.some((r) => r.includes("Schedule"))).toBe(
        true,
      );
    });
  });

  describe("Consistency", () => {
    it("should return consistent results for same input", async () => {
      const personas = generatePersonas({ seed: 42, count: 3, now });
      const persona = personas[0];
      const candidates = personas.slice(1);

      const result1 = await provider.smallPass({
        persona,
        candidates,
        domain: "friendship" as DomainMode,
        notes: "Consistency check",
      });

      const result2 = await provider.smallPass({
        persona,
        candidates,
        domain: "friendship" as DomainMode,
        notes: "Consistency check",
      });

      expect(result1.rankedIds).toEqual(result2.rankedIds);
    });
  });
});
