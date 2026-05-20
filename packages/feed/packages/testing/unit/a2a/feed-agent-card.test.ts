/**
 * A2A Feed Agent Card Unit Tests
 *
 * Tests for the Feed platform agent card definition
 */

import { describe, expect, it } from "bun:test";
import { feedAgentCard } from "@feed/a2a";

describe("Feed Agent Card", () => {
  describe("Protocol Compliance", () => {
    it("should have correct protocol version", () => {
      expect(feedAgentCard.protocolVersion).toBe("0.3.0");
    });

    it("should have correct name and description", () => {
      expect(feedAgentCard.name).toBe("Feed");
      expect(feedAgentCard.description).toContain("social conspiracy game");
      expect(feedAgentCard.description).toContain("prediction markets");
    });

    it("should have valid URL endpoint", () => {
      expect(feedAgentCard.url).toContain("/api/a2a");
    });

    it("should prefer JSONRPC transport", () => {
      expect(feedAgentCard.preferredTransport).toBe("JSONRPC");
    });
  });

  describe("Provider Information", () => {
    it("should have Feed as provider", () => {
      expect(feedAgentCard.provider?.organization).toBe("Feed");
      expect(feedAgentCard.provider?.url).toBe("https://feed.market");
    });
  });

  describe("Capabilities", () => {
    it("should declare streaming not supported", () => {
      expect(feedAgentCard.capabilities.streaming).toBe(false);
    });

    it("should declare push notifications not supported", () => {
      expect(feedAgentCard.capabilities.pushNotifications).toBe(false);
    });

    it("should declare state transition history supported", () => {
      expect(feedAgentCard.capabilities.stateTransitionHistory).toBe(true);
    });
  });

  describe("Security Configuration", () => {
    it("should have API key security scheme", () => {
      expect(feedAgentCard.securitySchemes).toBeDefined();
      expect(feedAgentCard.securitySchemes?.feedApiKey).toBeDefined();
    });

    it("should use header-based API key", () => {
      const scheme = feedAgentCard.securitySchemes?.feedApiKey;
      expect(scheme?.type).toBe("apiKey");
      expect((scheme as { in?: string })?.in).toBe("header");
      expect((scheme as { name?: string })?.name).toBe("X-Feed-Api-Key");
    });

    it("should have security requirements", () => {
      expect(feedAgentCard.security).toBeDefined();
      expect(feedAgentCard.security?.length).toBeGreaterThan(0);
    });
  });

  describe("Input/Output Modes", () => {
    it("should support text and JSON input", () => {
      expect(feedAgentCard.defaultInputModes).toContain("text/plain");
      expect(feedAgentCard.defaultInputModes).toContain("application/json");
    });

    it("should support JSON and text output", () => {
      expect(feedAgentCard.defaultOutputModes).toContain("application/json");
      expect(feedAgentCard.defaultOutputModes).toContain("text/plain");
    });
  });

  describe("Skills", () => {
    it("should have defined skills array", () => {
      expect(feedAgentCard.skills).toBeDefined();
      expect(Array.isArray(feedAgentCard.skills)).toBe(true);
      expect(feedAgentCard.skills.length).toBeGreaterThan(0);
    });

    it("should have social-feed skill", () => {
      const socialSkill = feedAgentCard.skills.find(
        (s) => s.id === "social-feed",
      );
      expect(socialSkill).toBeDefined();
      expect(socialSkill?.name).toContain("Social");
      expect(socialSkill?.tags).toContain("social");
    });

    it("should have prediction-markets skill", () => {
      const marketSkill = feedAgentCard.skills.find(
        (s) => s.id === "prediction-markets",
      );
      expect(marketSkill).toBeDefined();
      expect(marketSkill?.name).toContain("Prediction Market");
      expect(marketSkill?.tags).toContain("trading");
    });

    it("should have perpetual-futures skill", () => {
      const perpSkill = feedAgentCard.skills.find(
        (s) => s.id === "perpetual-futures",
      );
      expect(perpSkill).toBeDefined();
      expect(perpSkill?.name).toContain("Perpetual");
      expect(perpSkill?.tags).toContain("perpetuals");
    });

    it("should have messaging-chats skill", () => {
      const chatSkill = feedAgentCard.skills.find(
        (s) => s.id === "messaging-chats",
      );
      expect(chatSkill).toBeDefined();
      expect(chatSkill?.tags).toContain("messaging");
    });

    it("should have moderation-escrow skill", () => {
      const escrowSkill = feedAgentCard.skills.find(
        (s) => s.id === "moderation-escrow",
      );
      expect(escrowSkill).toBeDefined();
      expect(escrowSkill?.tags).toContain("escrow");
      expect(escrowSkill?.tags).toContain("moderation");
    });

    it("should have portfolio-balance skill", () => {
      const portfolioSkill = feedAgentCard.skills.find(
        (s) => s.id === "portfolio-balance",
      );
      expect(portfolioSkill).toBeDefined();
      expect(portfolioSkill?.tags).toContain("portfolio");
    });

    it("should have examples for each skill", () => {
      for (const skill of feedAgentCard.skills) {
        expect(skill.examples).toBeDefined();
        expect(skill.examples?.length).toBeGreaterThan(0);
      }
    });

    it("should have valid input/output modes for each skill", () => {
      for (const skill of feedAgentCard.skills) {
        expect(skill.inputModes).toBeDefined();
        expect(skill.outputModes).toBeDefined();
        expect(skill.outputModes).toContain("application/json");
      }
    });
  });

  describe("Additional Interfaces", () => {
    it("should have at least one additional interface", () => {
      expect(feedAgentCard.additionalInterfaces).toBeDefined();
      expect(feedAgentCard.additionalInterfaces?.length).toBeGreaterThan(0);
    });

    it("should use JSONRPC for additional interfaces", () => {
      const interfaces = feedAgentCard.additionalInterfaces;
      if (interfaces) {
        for (const iface of interfaces) {
          expect(iface.transport).toBe("JSONRPC");
        }
      }
    });
  });
});
