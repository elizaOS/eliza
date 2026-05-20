/**
 * Tests for NPC Anti-Repetition Service
 *
 * Verifies that repetition detection and avoidance works correctly.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  antiRepetitionService,
  getAvoidedPatternsContext,
} from "../../services/npc-anti-repetition-service";

describe("NPC Anti-Repetition Service", () => {
  afterEach(() => {
    antiRepetitionService.clearAllHistory();
  });

  describe("addPost and analyzePost", () => {
    it("should not flag repetition with few posts", () => {
      antiRepetitionService.addPost("actor1", "Hello world");
      antiRepetitionService.addPost("actor1", "Hello again");

      const analysis = antiRepetitionService.analyzePost(
        "actor1",
        "Hello test",
      );

      // Only 2 posts in history - too few to analyze
      expect(analysis.isRepetitive).toBe(false);
      expect(analysis.repetitionScore).toBe(0);
    });

    it("should detect overused opening phrases", () => {
      // Add posts all starting with same first 3 words (opening = first 3 words)
      // 40% threshold means if 2 out of 4 posts have same opening, it's flagged
      antiRepetitionService.addPost("actor1", "I am the greatest artist");
      antiRepetitionService.addPost("actor1", "I am the best coder");
      antiRepetitionService.addPost("actor1", "Something different here");
      antiRepetitionService.addPost("actor1", "Another unique post");

      // The proposed post also starts with "I am the" (same first 3 words)
      const analysis = antiRepetitionService.analyzePost(
        "actor1",
        "I am the future king",
      );

      // With 2/4 posts having "i am the" (50% > 40% threshold)
      expect(analysis.overusedOpenings).toContain("i am the");
      expect(analysis.repetitionScore).toBeGreaterThan(0);
    });

    it("should detect overused vocabulary", () => {
      // Add posts all using "cryptocurrency"
      antiRepetitionService.addPost("actor1", "Cryptocurrency is the future");
      antiRepetitionService.addPost("actor1", "Bitcoin cryptocurrency gains");
      antiRepetitionService.addPost("actor1", "More cryptocurrency news today");
      antiRepetitionService.addPost("actor1", "Cryptocurrency markets moving");

      const analysis = antiRepetitionService.analyzePost(
        "actor1",
        "Cryptocurrency update incoming",
      );

      expect(analysis.overusedWords).toContain("cryptocurrency");
    });

    it("should track separate histories per actor", () => {
      // Actor 1: 2/4 posts with same first 3 words (50% > 40% threshold)
      antiRepetitionService.addPost("actor1", "I am the greatest artist");
      antiRepetitionService.addPost("actor1", "I am the best ever");
      antiRepetitionService.addPost("actor1", "Something else entirely");
      antiRepetitionService.addPost("actor1", "Another unique thing");

      // Actor 2 never starts with "I am the"
      antiRepetitionService.addPost("actor2", "Goodbye cruel world today");
      antiRepetitionService.addPost("actor2", "Different start here");
      antiRepetitionService.addPost("actor2", "Something new today");
      antiRepetitionService.addPost("actor2", "Yet another post");

      // "I am the" should be flagged for actor1 but not actor2
      const analysis1 = antiRepetitionService.analyzePost(
        "actor1",
        "I am the next one",
      );
      const analysis2 = antiRepetitionService.analyzePost(
        "actor2",
        "I am the next one",
      );

      expect(analysis1.overusedOpenings.length).toBeGreaterThan(0);
      expect(analysis2.overusedOpenings.length).toBe(0);
    });
  });

  describe("getAvoidedOpenings", () => {
    it("should return empty for new actors", () => {
      const openings = antiRepetitionService.getAvoidedOpenings("new-actor");
      expect(openings).toEqual([]);
    });

    it("should return overused openings", () => {
      for (let i = 0; i < 5; i++) {
        antiRepetitionService.addPost("actor1", `Starting phrase is ${i}`);
      }

      const openings = antiRepetitionService.getAvoidedOpenings("actor1");
      expect(openings.length).toBeGreaterThan(0);
      expect(openings[0]).toContain("starting");
    });
  });

  describe("getAvoidedPatternsContext", () => {
    it("should return empty string for new actors", () => {
      const context = getAvoidedPatternsContext("new-actor");
      expect(context).toBe("");
    });

    it("should return formatted context for actors with repetition issues", () => {
      for (let i = 0; i < 5; i++) {
        antiRepetitionService.addPost(
          "actor1",
          `Same opening always ${i} with cryptocurrency`,
        );
      }

      const context = getAvoidedPatternsContext("actor1");

      expect(context).toContain("AVOID THESE");
      expect(context).toContain("Do NOT start with");
    });
  });

  describe("clearHistory", () => {
    it("should clear history for specific actor", () => {
      antiRepetitionService.addPost("actor1", "Test post");
      antiRepetitionService.addPost("actor2", "Test post");

      antiRepetitionService.clearHistory("actor1");

      const stats = antiRepetitionService.getStats();
      expect(stats.actor1).toBeUndefined();
      expect(stats.actor2).toBeDefined();
    });
  });

  describe("getStats", () => {
    it("should return stats for all tracked actors", () => {
      antiRepetitionService.addPost("actor1", "Post 1");
      antiRepetitionService.addPost("actor1", "Post 2");
      antiRepetitionService.addPost("actor2", "Post 1");

      const stats = antiRepetitionService.getStats();

      expect(stats.actor1.postCount).toBe(2);
      expect(stats.actor2.postCount).toBe(1);
      expect(stats.actor1.lastUpdated).toBeDefined();
    });
  });
});
