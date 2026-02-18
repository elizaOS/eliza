import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { transactionGuardEvaluator } from "./transaction-guard.js";
import { setScoutClient, setScoutConfig } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";
import type { ServiceScoreResponse } from "../client/types.js";
import { DEFAULT_CONFIG } from "../config.js";

function makeMessage(text: string): Memory {
  return {
    content: { text },
    userId: "user-1",
    agentId: "agent-1",
    roomId: "room-1",
  } as Memory;
}

function makeRuntime(): IAgentRuntime {
  return { agentId: "agent-1" } as unknown as IAgentRuntime;
}

function makeScoreResponse(overrides: Partial<ServiceScoreResponse> = {}): ServiceScoreResponse {
  return {
    success: true,
    domain: "test.com",
    resourceUrl: "https://test.com/api",
    score: 80,
    level: "HIGH",
    dimensions: { contractClarity: 80, availability: 90, responseFidelity: 70, identitySafety: 80 },
    flags: [],
    recommendation: {
      verdict: "RECOMMENDED",
      message: "Trusted service",
      maxTransaction: 5000,
      escrowAdvised: false,
      escrowReason: "",
      paymentMethod: "direct_preferred",
      riskFactors: [],
      suggestedTerms: { upfront: "100%", onCompletion: "0%", escrow: "not_needed", releaseConditions: "" },
    },
    serviceInfo: { description: "Test", priceUSD: 1, network: "base", wallet: null, hasSchema: true, lastUpdated: "" },
    _meta: { tier: "free", dataSource: "bazaar", scoredAt: "" },
    ...overrides,
  } as ServiceScoreResponse;
}

describe("transactionGuardEvaluator", () => {
  describe("validate", () => {
    const runtime = makeRuntime();

    it("returns true for payment keyword + domain", async () => {
      expect(await transactionGuardEvaluator.validate(runtime, makeMessage("Pay $500 to api.questflow.ai"))).toBe(true);
    });

    it("returns true for 'send' keyword + domain", async () => {
      expect(await transactionGuardEvaluator.validate(runtime, makeMessage("send 100 usdc to test.com"))).toBe(true);
    });

    it("returns false for payment keyword without domain", async () => {
      expect(await transactionGuardEvaluator.validate(runtime, makeMessage("pay me now"))).toBe(false);
    });

    it("returns false for domain without payment keyword", async () => {
      expect(await transactionGuardEvaluator.validate(runtime, makeMessage("check questflow.ai"))).toBe(false);
    });

    it("returns false for empty message", async () => {
      expect(await transactionGuardEvaluator.validate(runtime, makeMessage(""))).toBe(false);
    });

    it("is case insensitive for keywords", async () => {
      expect(await transactionGuardEvaluator.validate(runtime, makeMessage("PURCHASE from api.test.com"))).toBe(true);
    });
  });

  describe("handler", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getServiceScore: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getServiceScore: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
      setScoutConfig(runtime, { ...DEFAULT_CONFIG });
    });

    it("returns blocked for auto-reject flags", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ flags: ["WALLET_SPAM_FARM"], score: 10, level: "VERY_LOW" })
      );

      const callback = vi.fn();
      const result = await transactionGuardEvaluator.handler(
        runtime, makeMessage("pay $100 to evil.com"), undefined, undefined, callback
      );

      expect(result).toEqual({
        success: true,
        data: { blocked: true, reason: "auto_reject_flags", flags: ["WALLET_SPAM_FARM"] },
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("BLOCKED") })
      );
    });

    it("returns warning for score below minimum", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ score: 30, level: "LOW", flags: [] })
      );

      const callback = vi.fn();
      const result = await transactionGuardEvaluator.handler(
        runtime, makeMessage("pay $100 to low.com"), undefined, undefined, callback
      );

      expect(result).toEqual({
        success: true,
        data: { blocked: false, warning: true, reason: "below_min_score" },
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("WARNING") })
      );
    });

    it("returns warning for amount exceeding max transaction", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ score: 60, level: "MEDIUM" })
      );

      const callback = vi.fn();
      // USABLE verdict maxTransaction is 1000
      const result = await transactionGuardEvaluator.handler(
        runtime, makeMessage("pay $2000 to medium.com"), undefined, undefined, callback
      );

      expect(result).toEqual({
        success: true,
        data: { blocked: false, warning: true, reason: "exceeds_max_transaction" },
      });
    });

    it("returns all-clear for safe transaction", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ score: 80, level: "HIGH", flags: [] })
      );

      const callback = vi.fn();
      const result = await transactionGuardEvaluator.handler(
        runtime, makeMessage("pay $100 to safe.com"), undefined, undefined, callback
      );

      expect(result).toEqual({
        success: true,
        data: { blocked: false, warning: false },
      });
    });

    it("returns warning on API failure (fail-open)", async () => {
      mockClient.getServiceScore.mockRejectedValue(new Error("Network error"));

      const callback = vi.fn();
      const result = await transactionGuardEvaluator.handler(
        runtime, makeMessage("pay $100 to down.com"), undefined, undefined, callback
      );

      expect(result).toEqual({
        success: true,
        data: { blocked: false, warning: true, reason: "api_unavailable" },
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Unable to verify") })
      );
    });

    it("succeeds silently when plugin is not initialized", async () => {
      const bareRuntime = makeRuntime();
      // No client/config set

      const result = await transactionGuardEvaluator.handler(
        bareRuntime, makeMessage("pay $100 to test.com"), undefined, undefined, vi.fn()
      );

      expect(result).toEqual({ success: true });
    });

    it("parses $5.5 correctly (single decimal digit)", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ score: 80, level: "HIGH", flags: [] })
      );

      const callback = vi.fn();
      await transactionGuardEvaluator.handler(
        runtime, makeMessage("pay $5.5 to test.com"), undefined, undefined, callback
      );

      // $5.5 should be parsed as 5.5, within RECOMMENDED max of $5000
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("$5.5") })
      );
    });

    it("parses amounts with commas", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ score: 80, level: "HIGH", flags: [] })
      );

      const callback = vi.fn();
      await transactionGuardEvaluator.handler(
        runtime, makeMessage("pay $1,000.00 to test.com"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("$1000") })
      );
    });

    it("parses USDC amounts", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ score: 80, level: "HIGH", flags: [] })
      );

      const callback = vi.fn();
      await transactionGuardEvaluator.handler(
        runtime, makeMessage("send 500 USDC to test.com"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("$500") })
      );
    });
  });
});