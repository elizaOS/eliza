/**
 * OASF Skill Mapper Unit Tests
 * Tests for OASF taxonomy skill/domain mapping utility
 */

import { describe, expect, it } from "bun:test";
import type { ActorData } from "@feed/shared";
import {
  mapActorToOASFDomains,
  mapActorToOASFSkills,
  OASFDomainCategories,
  OASFSkillCategories,
  suggestDomainsFromKeywords,
  suggestSkillsFromKeywords,
  validateOASFDomainPath,
  validateOASFSkillPath,
} from "@feed/shared";

describe("OASF Skill Mapper", () => {
  describe("mapActorToOASFSkills", () => {
    it("should map trader NPC to trading skills", () => {
      const actorData: ActorData = {
        id: "test-trader",
        name: "Test Trader",
        realName: "Test Trader",
        username: "testtrader",
        originalFirstName: "Test",
        originalLastName: "Trader",
        originalHandle: "testtrader",
        role: "trader",
        description: "A skilled trader in prediction markets",
      };

      const skills = mapActorToOASFSkills(actorData);

      expect(skills).toContain(OASFSkillCategories.TRADING);
      expect(skills).toContain(OASFSkillCategories.RISK_ANALYSIS);
      expect(skills).toContain(OASFSkillCategories.DATA_ANALYSIS);
      expect(skills.length).toBeGreaterThan(0);
    });

    it("should map analyst NPC to analysis skills", () => {
      const actorData: ActorData = {
        id: "test-analyst",
        name: "Test Analyst",
        realName: "Test Analyst",
        username: "testanalyst",
        originalFirstName: "Test",
        originalLastName: "Analyst",
        originalHandle: "testanalyst",
        role: "analyst",
        description: "Market analysis expert",
      };

      const skills = mapActorToOASFSkills(actorData);

      expect(skills).toContain(OASFSkillCategories.DATA_ANALYSIS);
      expect(skills).toContain(OASFSkillCategories.PREDICTION);
      expect(skills).toContain(OASFSkillCategories.FINANCE);
    });

    it("should extract skills from description keywords", () => {
      const actorData: ActorData = {
        id: "test-social",
        name: "Test Social",
        realName: "Test Social",
        username: "testsocial",
        originalFirstName: "Test",
        originalLastName: "Social",
        originalHandle: "testsocial",
        description: "Expert in social media and content creation",
      };

      const skills = mapActorToOASFSkills(actorData);

      expect(skills).toContain(OASFSkillCategories.SOCIAL_MEDIA);
      expect(skills).toContain(OASFSkillCategories.CONTENT_CREATION);
    });

    it("should return default skills for unknown type", () => {
      const actorData: ActorData = {
        id: "test-unknown",
        name: "Test Unknown",
        realName: "Test Unknown",
        username: "testunknown",
        originalFirstName: "Test",
        originalLastName: "Unknown",
        originalHandle: "testunknown",
        description: "Generic NPC",
      };

      const skills = mapActorToOASFSkills(actorData);

      expect(skills).toContain(OASFSkillCategories.DIALOGUE);
      expect(skills).toContain(OASFSkillCategories.NLP);
      expect(skills).toContain(OASFSkillCategories.REASONING);
    });

    it("should remove duplicate skills", () => {
      const actorData: ActorData = {
        id: "test-duplicate",
        name: "Test",
        realName: "Test Trader",
        username: "testdupe",
        originalFirstName: "Test",
        originalLastName: "Trader",
        originalHandle: "testdupe",
        role: "trader",
        description: "Trading expert who loves to trade",
      };

      const skills = mapActorToOASFSkills(actorData);
      const uniqueSkills = new Set(skills);

      expect(skills.length).toBe(uniqueSkills.size);
    });
  });

  describe("mapActorToOASFDomains", () => {
    it("should map trader NPC to finance domains", () => {
      const actorData: ActorData = {
        id: "test-trader",
        name: "Test Trader",
        realName: "Test Trader",
        username: "testtrader",
        originalFirstName: "Test",
        originalLastName: "Trader",
        originalHandle: "testtrader",
        role: "trader",
        description: "Trading specialist",
      };

      const domains = mapActorToOASFDomains(actorData);

      expect(domains).toContain(OASFDomainCategories.TRADING_MARKETS);
      expect(domains).toContain(OASFDomainCategories.FINANCE);
      expect(domains).toContain(OASFDomainCategories.GAMING);
    });

    it("should map influencer NPC to social domains", () => {
      const actorData: ActorData = {
        id: "test-influencer",
        name: "Test Influencer",
        realName: "Test Influencer",
        username: "testinfluencer",
        originalFirstName: "Test",
        originalLastName: "Influencer",
        originalHandle: "testinfluencer",
        role: "influencer",
        description: "Social media expert",
      };

      const domains = mapActorToOASFDomains(actorData);

      expect(domains).toContain(OASFDomainCategories.SOCIAL_NETWORKING);
      expect(domains).toContain(OASFDomainCategories.COMMUNITY_PLATFORMS);
    });

    it("should extract domains from description keywords", () => {
      const actorData: ActorData = {
        id: "test-investor",
        name: "Test Investor",
        realName: "Test Investor",
        username: "testinvestor",
        originalFirstName: "Test",
        originalLastName: "Investor",
        originalHandle: "testinvestor",
        description: "Investment and finance specialist",
      };

      const domains = mapActorToOASFDomains(actorData);

      expect(domains).toContain(OASFDomainCategories.FINANCE);
      expect(domains).toContain(OASFDomainCategories.INVESTMENT);
    });

    it("should handle prediction market references", () => {
      const actorData: ActorData = {
        id: "test-predictor",
        name: "Test Predictor",
        realName: "Test Predictor",
        username: "testpredictor",
        originalFirstName: "Test",
        originalLastName: "Predictor",
        originalHandle: "testpredictor",
        description: "Prediction market participant",
      };

      const domains = mapActorToOASFDomains(actorData);

      expect(domains).toContain(OASFDomainCategories.GAMING);
    });
  });

  describe("validateOASFSkillPath", () => {
    it("should validate correct skill paths", () => {
      expect(validateOASFSkillPath("natural_language_processing")).toBe(true);
      expect(validateOASFSkillPath("finance_and_business/trading")).toBe(true);
      expect(
        validateOASFSkillPath("data_analysis/predictive_analytics/forecasting"),
      ).toBe(true);
    });

    it("should reject invalid skill paths", () => {
      expect(validateOASFSkillPath("Invalid Path")).toBe(false);
      expect(validateOASFSkillPath("path with spaces")).toBe(false);
      expect(validateOASFSkillPath("PATH/WITH/CAPS")).toBe(false);
      expect(validateOASFSkillPath("path-with-dashes")).toBe(false);
      expect(validateOASFSkillPath("path/with//double//slash")).toBe(false);
    });

    it("should accept paths with numbers", () => {
      expect(validateOASFSkillPath("skill_123")).toBe(true);
      expect(validateOASFSkillPath("category_1/skill_2")).toBe(true);
    });
  });

  describe("validateOASFDomainPath", () => {
    it("should validate correct domain paths", () => {
      expect(validateOASFDomainPath("finance_and_business")).toBe(true);
      expect(
        validateOASFDomainPath("finance_and_business/trading_and_markets"),
      ).toBe(true);
    });

    it("should reject invalid domain paths", () => {
      expect(validateOASFDomainPath("Invalid Domain")).toBe(false);
      expect(validateOASFDomainPath("domain with spaces")).toBe(false);
    });
  });

  describe("suggestSkillsFromKeywords", () => {
    it("should suggest trading skills for trading keywords", () => {
      const keywords = ["trade", "trading", "market"];
      const suggestions = suggestSkillsFromKeywords(keywords);

      expect(suggestions).toContain(OASFSkillCategories.TRADING);
    });

    it("should suggest multiple skills from diverse keywords", () => {
      const keywords = ["investment", "analyze", "predict", "dialogue"];
      const suggestions = suggestSkillsFromKeywords(keywords);

      expect(suggestions).toContain(OASFSkillCategories.INVESTMENT);
      expect(suggestions).toContain(OASFSkillCategories.DATA_ANALYSIS);
      expect(suggestions).toContain(OASFSkillCategories.PREDICTION);
      expect(suggestions).toContain(OASFSkillCategories.DIALOGUE);
    });

    it("should handle case-insensitive keywords", () => {
      const keywords = ["TRADE", "TrAdInG", "INVEST"];
      const suggestions = suggestSkillsFromKeywords(keywords);

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions).toContain(OASFSkillCategories.TRADING);
      expect(suggestions).toContain(OASFSkillCategories.INVESTMENT);
    });

    it("should return empty array for irrelevant keywords", () => {
      const keywords = ["irrelevant", "random", "words"];
      const suggestions = suggestSkillsFromKeywords(keywords);

      expect(suggestions.length).toBe(0);
    });
  });

  describe("suggestDomainsFromKeywords", () => {
    it("should suggest finance domains for financial keywords", () => {
      const keywords = ["finance", "investment", "market"];
      const suggestions = suggestDomainsFromKeywords(keywords);

      expect(suggestions).toContain(OASFDomainCategories.FINANCE);
      expect(suggestions).toContain(OASFDomainCategories.INVESTMENT);
      expect(suggestions).toContain(OASFDomainCategories.TRADING_MARKETS);
    });

    it("should suggest gaming domain for gaming keywords", () => {
      const keywords = ["gaming", "game"];
      const suggestions = suggestDomainsFromKeywords(keywords);

      expect(suggestions).toContain(OASFDomainCategories.GAMING);
    });

    it("should handle multiple domain keywords", () => {
      const keywords = ["social", "education", "game"];
      const suggestions = suggestDomainsFromKeywords(keywords);

      expect(suggestions).toContain(OASFDomainCategories.SOCIAL_NETWORKING);
      expect(suggestions).toContain(OASFDomainCategories.EDUCATION);
      expect(suggestions).toContain(OASFDomainCategories.GAMING);
    });
  });

  describe("Integration tests", () => {
    it("should provide valid OASF paths for all NPC types", () => {
      const npcTypes = [
        "trader",
        "analyst",
        "investor",
        "influencer",
        "moderator",
      ];

      for (const type of npcTypes) {
        const actorData: ActorData = {
          id: `test-${type}`,
          name: `Test ${type}`,
          realName: `Test ${type}`,
          username: `test${type}`,
          originalFirstName: "Test",
          originalLastName: type.charAt(0).toUpperCase() + type.slice(1),
          originalHandle: `test${type}`,
          role: type,
          description: `Test ${type} description`,
        };

        const skills = mapActorToOASFSkills(actorData);
        const domains = mapActorToOASFDomains(actorData);

        // All skills should be valid
        for (const skill of skills) {
          expect(validateOASFSkillPath(skill)).toBe(true);
        }

        // All domains should be valid
        for (const domain of domains) {
          expect(validateOASFDomainPath(domain)).toBe(true);
        }

        // Should have at least one skill and domain
        expect(skills.length).toBeGreaterThan(0);
        expect(domains.length).toBeGreaterThan(0);
      }
    });

    it("should map complex actor data correctly", () => {
      const actorData: ActorData = {
        id: "complex-trader",
        name: "Complex Trader",
        realName: "Complex Trader",
        username: "complextrader",
        originalFirstName: "Complex",
        originalLastName: "Trader",
        originalHandle: "complextrader",
        role: "Market Analyst",
        description:
          "Expert trader with social media presence and content creation skills. Specializes in prediction markets and investment analysis.",
      };

      const skills = mapActorToOASFSkills(actorData);
      const domains = mapActorToOASFDomains(actorData);

      // Should have trader skills
      expect(skills).toContain(OASFSkillCategories.TRADING);
      expect(skills).toContain(OASFSkillCategories.INVESTMENT);
      expect(skills).toContain(OASFSkillCategories.PREDICTION);

      // Should have social skills from description
      expect(skills).toContain(OASFSkillCategories.SOCIAL_MEDIA);
      expect(skills).toContain(OASFSkillCategories.CONTENT_CREATION);

      // Should have finance domains
      expect(domains).toContain(OASFDomainCategories.TRADING_MARKETS);
      expect(domains).toContain(OASFDomainCategories.INVESTMENT);

      // Should have gaming domain from prediction markets
      expect(domains).toContain(OASFDomainCategories.GAMING);
    });
  });
});
