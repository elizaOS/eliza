/**
 * LLM Provider Tests
 *
 * Verifies that the multi-provider LLM support works correctly
 */

import { describe, expect, it } from "bun:test";
import dotenv from "dotenv";
import { AgentDecisionMaker } from "../src/decision";

dotenv.config({ path: ".env.local" });

describe("LLM Provider Configuration", () => {
  it("should reject when no API keys provided", () => {
    expect(() => {
      new AgentDecisionMaker({
        strategy: "balanced",
        groqApiKey: undefined,
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
      });
    }).toThrow("At least one LLM API key is required");
  });

  it("should accept Groq API key", () => {
    const maker = new AgentDecisionMaker({
      strategy: "balanced",
      groqApiKey: "test-key",
    });

    expect(maker.getProvider()).toContain("Groq");
  });

  it("should fall back to Claude if Groq not provided", () => {
    const maker = new AgentDecisionMaker({
      strategy: "balanced",
      anthropicApiKey: "test-key",
    });

    expect(maker.getProvider()).toContain("Claude");
  });

  it("should fall back to OpenAGI if neither Groq nor Claude provided", () => {
    const maker = new AgentDecisionMaker({
      strategy: "balanced",
      openaiApiKey: "test-key",
    });

    expect(maker.getProvider()).toContain("OpenAGI");
  });

  it("should prefer Groq over Claude and OpenAGI", () => {
    const maker = new AgentDecisionMaker({
      strategy: "balanced",
      groqApiKey: "groq-key",
      anthropicApiKey: "claude-key",
      openaiApiKey: "openai-key",
    });

    expect(maker.getProvider()).toContain("Groq");
  });

  it("should prefer Claude over OpenAGI when Groq not available", () => {
    const maker = new AgentDecisionMaker({
      strategy: "balanced",
      anthropicApiKey: "claude-key",
      openaiApiKey: "openai-key",
    });

    expect(maker.getProvider()).toContain("Claude");
  });
});

describe("LLM Provider Live Test", () => {
  const hasLLMKey = !!(
    process.env.GROQ_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY
  );

  if (hasLLMKey) {
    it("should make a real decision with configured provider", async () => {
      const maker = new AgentDecisionMaker({
        strategy: "balanced",
        groqApiKey: process.env.GROQ_API_KEY,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        openaiApiKey: process.env.OPENAI_API_KEY,
      });

      console.log(`   Using: ${maker.getProvider()}`);

      const decision = await maker.decide({
        portfolio: { balance: 1000, positions: [], pnl: 0 },
        markets: {
          predictions: [
            {
              id: "test-1",
              question: "Will Bitcoin reach $100k?",
              yesShares: 35,
              noShares: 65,
            },
          ],
          perps: [],
        },
        feed: { posts: [] },
        memory: [],
      });

      expect(decision).toBeDefined();
      expect(decision.action).toBeDefined();
      expect([
        "BUY_YES",
        "BUY_NO",
        "SELL",
        "OPEN_LONG",
        "OPEN_SHORT",
        "CLOSE_POSITION",
        "CREATE_POST",
        "CREATE_COMMENT",
        "HOLD",
      ]).toContain(decision.action);

      console.log(`   Decision: ${decision.action}`);
      if (decision.reasoning) {
        console.log(`   Reasoning: ${decision.reasoning.substring(0, 60)}...`);
      }
    }, 15000);
  } else {
    it("Live LLM test skipped - no API keys configured", () => {
      console.log("\n⚠️  Live LLM test skipped");
      console.log("   Configure at least one API key to test:");
      console.log("   - GROQ_API_KEY");
      console.log("   - ANTHROPIC_API_KEY");
      console.log("   - OPENAI_API_KEY\n");
      // Test skipped - no API keys configured
    });
  }
});
