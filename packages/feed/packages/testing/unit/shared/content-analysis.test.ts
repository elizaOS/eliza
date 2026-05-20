/**
 * Content Analysis Unit Tests
 * Tests for content analysis utilities (sentiment, certainty, etc.)
 */

import { describe, expect, it } from "bun:test";
import {
  analyzeCertainty,
  analyzeSentiment,
  calculateContentQuality,
  calculateFreshness,
  detectPrediction,
  hasInsiderLanguage,
} from "@feed/shared";

describe("Content Analysis", () => {
  describe("analyzeCertainty", () => {
    it("should detect high certainty in content", () => {
      const certainContent =
        "This is definitely going to happen. It is certain.";
      const certainty = analyzeCertainty(certainContent);
      expect(certainty).toBeGreaterThan(0.5);
    });

    it("should detect low certainty in hedged content", () => {
      const hedgedContent = "This might possibly happen. It seems unclear.";
      const certainty = analyzeCertainty(hedgedContent);
      expect(certainty).toBeLessThan(0.5);
    });

    it("should return neutral for ambiguous content", () => {
      const neutralContent = "The weather is nice today.";
      const certainty = analyzeCertainty(neutralContent);
      expect(certainty).toBeCloseTo(0.5, 1);
    });

    it("should clamp certainty between 0 and 1", () => {
      const veryCertain =
        "Definitely certainly confirmed guaranteed proven verified established";
      const veryUncertain =
        "Maybe possibly perhaps might could probably potentially seems appears";

      expect(analyzeCertainty(veryCertain)).toBeLessThanOrEqual(1);
      expect(analyzeCertainty(veryCertain)).toBeGreaterThanOrEqual(0);
      expect(analyzeCertainty(veryUncertain)).toBeLessThanOrEqual(1);
      expect(analyzeCertainty(veryUncertain)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("hasInsiderLanguage", () => {
    it("should detect insider language patterns", () => {
      expect(hasInsiderLanguage("My sources tell me this will happen")).toBe(
        true,
      );
      expect(hasInsiderLanguage("Sources confirm the deal")).toBe(true);
      expect(hasInsiderLanguage("This is confidential information")).toBe(true);
      expect(hasInsiderLanguage("I heard from an insider")).toBe(true);
    });

    it("should not flag regular content", () => {
      expect(hasInsiderLanguage("I think this will happen")).toBe(false);
      expect(hasInsiderLanguage("The market is looking good")).toBe(false);
      expect(hasInsiderLanguage("Based on public data")).toBe(false);
    });
  });

  describe("analyzeSentiment", () => {
    it("should detect positive sentiment", () => {
      const positive = "This is great news! Amazing success and a win for all.";
      const sentiment = analyzeSentiment(positive);
      expect(sentiment).toBeGreaterThan(0);
    });

    it("should detect negative sentiment", () => {
      const negative =
        "This is terrible news. A complete failure and disaster.";
      const sentiment = analyzeSentiment(negative);
      expect(sentiment).toBeLessThan(0);
    });

    it("should return neutral for neutral content", () => {
      const neutral = "The report was released today.";
      const sentiment = analyzeSentiment(neutral);
      expect(sentiment).toBeCloseTo(0, 1);
    });

    it("should clamp sentiment between -1 and 1", () => {
      const veryPositive =
        "great amazing success win best love excellent awesome";
      const veryNegative =
        "terrible awful failure worst hate disaster crisis scandal";

      expect(analyzeSentiment(veryPositive)).toBeLessThanOrEqual(1);
      expect(analyzeSentiment(veryPositive)).toBeGreaterThanOrEqual(-1);
      expect(analyzeSentiment(veryNegative)).toBeLessThanOrEqual(1);
      expect(analyzeSentiment(veryNegative)).toBeGreaterThanOrEqual(-1);
    });
  });

  describe("calculateFreshness", () => {
    it("should return 1.0 for current day posts", () => {
      expect(calculateFreshness(10, 10)).toBeCloseTo(1.0, 2);
    });

    it("should decrease freshness for older posts", () => {
      const freshnessDay5 = calculateFreshness(5, 10);
      const freshnessDay1 = calculateFreshness(1, 10);

      expect(freshnessDay5).toBeLessThan(1.0);
      expect(freshnessDay1).toBeLessThan(freshnessDay5);
    });

    it("should have minimum freshness of 0.3", () => {
      const veryOldFreshness = calculateFreshness(1, 30);
      expect(veryOldFreshness).toBeGreaterThanOrEqual(0.3);
    });
  });

  describe("calculateContentQuality", () => {
    it("should calculate quality score between 0 and 100", () => {
      const quality = calculateContentQuality(
        "This is a test post about markets",
        "analyst",
        10,
        10,
        0.8,
      );

      expect(quality).toBeGreaterThanOrEqual(0);
      expect(quality).toBeLessThanOrEqual(100);
    });

    it("should give higher score to insider content with good track record", () => {
      const insiderQuality = calculateContentQuality(
        "My sources confirm this will happen",
        "insider",
        10,
        10,
        0.9,
      );

      const regularQuality = calculateContentQuality(
        "I think this might happen",
        "extra",
        10,
        10,
        0.5,
      );

      expect(insiderQuality).toBeGreaterThan(regularQuality);
    });

    it("should work with minimal parameters", () => {
      const quality = calculateContentQuality("Basic content");
      expect(quality).toBeGreaterThanOrEqual(0);
      expect(quality).toBeLessThanOrEqual(100);
    });
  });

  describe("detectPrediction", () => {
    it("should detect YES predictions", () => {
      // Use the exact phrases that detectPrediction looks for
      const result = detectPrediction("This will happen for sure, guaranteed");
      expect(result.makesPrediction).toBe(true);
      expect(result.direction).toBe("YES");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should detect NO predictions", () => {
      const result = detectPrediction("This won't happen, it's impossible");
      expect(result.makesPrediction).toBe(true);
      expect(result.direction).toBe("NO");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should return UNCLEAR for ambiguous content", () => {
      const result = detectPrediction("The market is interesting");
      expect(result.makesPrediction).toBe(false);
      expect(result.direction).toBe("UNCLEAR");
      expect(result.confidence).toBe(0);
    });
  });
});
