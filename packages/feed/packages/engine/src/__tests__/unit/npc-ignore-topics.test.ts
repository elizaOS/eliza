/**
 * Tests for Actor Domain Filtering with ignoreTopics
 *
 * Verifies that actors can ignore specific topics:
 * - ignoreTopics blocks content generation
 * - engagementThreshold affects off-domain probability
 * - Domain keywords are properly matched
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldPostAboutTopic } from "../../services/npc-character-config";
import { StaticDataRegistry } from "../../services/static-data-registry";

describe("NPC Character Config - ignoreTopics & engagementThreshold", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Actor ignoreTopics configuration", () => {
    it("should have ignoreTopics defined for kanyai-west actor", () => {
      const actor = StaticDataRegistry.getActor("kanyai-west");
      expect(actor).not.toBeNull();
      expect(actor?.ignoreTopics).toBeDefined();
      expect(actor?.ignoreTopics).toContain("sec");
      expect(actor?.ignoreTopics).toContain("regulation");
      expect(actor?.ignoreTopics).toContain("legal");
    });

    it("should have engagementThreshold defined for kanyai-west actor", () => {
      const actor = StaticDataRegistry.getActor("kanyai-west");
      expect(actor?.engagementThreshold).toBeDefined();
      expect(actor?.engagementThreshold).toBe(0.95);
    });
  });

  describe("shouldPostAboutTopic basic behavior", () => {
    it("should return true for on-domain topics", () => {
      // KanyAI cares about music, fashion, culture
      vi.spyOn(Math, "random").mockReturnValue(0);

      expect(
        shouldPostAboutTopic(
          "kanyai-west",
          "New fashion trends in music industry",
        ),
      ).toBe(true);

      expect(
        shouldPostAboutTopic("kanyai-west", "Cultural impact of hip hop"),
      ).toBe(true);
    });

    it("should allow unknown actors to post about anything", () => {
      expect(
        shouldPostAboutTopic("unknown-actor-xyz", "Any random topic here"),
      ).toBe(true);

      expect(shouldPostAboutTopic("unknown-actor-xyz", "SEC regulations")).toBe(
        true,
      );
    });

    it("should return true for on-domain topics regardless of probability", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.99);

      // Music is in KanyAI's domain
      expect(
        shouldPostAboutTopic("kanyai-west", "New music album release"),
      ).toBe(true);
    });
  });

  describe("shouldPostAboutTopic with engagementThreshold", () => {
    it("should reduce off-domain probability for high threshold actors", () => {
      // KanyAI has engagementThreshold: 0.8 (high - rarely posts off-domain)
      let offDomainPosts = 0;
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        // Topic about crypto (not in Kanye's domain of music/fashion/culture)
        if (shouldPostAboutTopic("kanyai-west", "Bitcoin price prediction")) {
          offDomainPosts++;
        }
      }

      // With high threshold, should very rarely post off-domain
      // Allow some variance but should be significantly lower than 50%
      expect(offDomainPosts).toBeLessThan(iterations * 0.4);
    });

    it("should use default threshold (0.5) for actors without explicit threshold", () => {
      let offDomainPosts = 0;
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        // Pick a topic that's definitely off-domain for this actor
        if (
          shouldPostAboutTopic(
            "trump-terminal",
            "Advanced machine learning techniques",
          )
        ) {
          offDomainPosts++;
        }
      }

      // With default threshold, moderate off-domain probability
      // Should be somewhere in the middle range
      expect(offDomainPosts).toBeLessThan(iterations * 0.5);
    });
  });

  describe("Domain matching", () => {
    it("should work normally for actors without ignoreTopics", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);

      // Actors without ignoreTopics should follow normal domain logic
      expect(shouldPostAboutTopic("dairiio-amodei", "AI safety debate")).toBe(
        true,
      );

      expect(
        shouldPostAboutTopic("brian-airmstrong", "crypto exchange news"),
      ).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty topic text for actors without domains", () => {
      // Unknown actors have no domains, so empty topic returns true
      expect(shouldPostAboutTopic("unknown-actor-xyz", "")).toBe(true);
    });

    it("should handle topics with no keyword matches", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);

      // Topic with no recognizable keywords - falls to off-domain probability
      const result = shouldPostAboutTopic("kanyai-west", "xyz123 foo bar baz");
      expect(typeof result).toBe("boolean"); // Just verify it doesn't throw
    });
  });
});
