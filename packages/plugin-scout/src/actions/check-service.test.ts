import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { checkServiceAction } from "./check-service.js";
import { setScoutClient } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";
import type { ServiceScoreResponse } from "../client/types.js";
import { ScoutApiError } from "../client/scout-client.js";

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

describe("checkServiceAction", () => {
  describe("validate", () => {
    const runtime = makeRuntime();

    it("returns true when a domain is present", async () => {
      expect(await checkServiceAction.validate(runtime, makeMessage("check questflow.ai"))).toBe(true);
    });

    it("returns false when no domain is present", async () => {
      expect(await checkServiceAction.validate(runtime, makeMessage("tell me about trust"))).toBe(false);
    });

    it("returns false for empty message", async () => {
      expect(await checkServiceAction.validate(runtime, makeMessage(""))).toBe(false);
    });
  });

  describe("handler", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getServiceScore: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getServiceScore: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("returns success with formatted trust report", async () => {
      mockClient.getServiceScore.mockResolvedValue(makeScoreResponse());
      const callback = vi.fn();

      const result = await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);

      expect(result).toEqual({ success: true, data: expect.any(Object) });
      expect(callback).toHaveBeenCalledTimes(1);
      const text = callback.mock.calls[0][0].text;
      expect(text).toContain("Scout Trust Score for test.com");
      expect(text).toContain("80/100");
      expect(text).toContain("RECOMMENDED");
      expect(text).toContain("Contract Clarity: 80/100");
      expect(text).toContain("Availability: 90/100");
    });

    it("includes endpoint health when present", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ endpointHealth: { status: "UP", statusCode: 402, latencyMs: 150, lastChecked: "" } })
      );
      const callback = vi.fn();

      await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);
      expect(callback.mock.calls[0][0].text).toContain("**Endpoint Health**: UP (150ms)");
    });

    it("includes fidelity score when present", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({
          fidelity: { score: 75, protocolScore: 80, consistencyScore: 70, structureScore: 75, checksTotal: 5, lastChecked: "" },
        })
      );
      const callback = vi.fn();

      await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);
      expect(callback.mock.calls[0][0].text).toContain("**Fidelity Score**: 75/100 (5 checks)");
    });

    it("omits endpoint health and fidelity when absent", async () => {
      mockClient.getServiceScore.mockResolvedValue(makeScoreResponse());
      const callback = vi.fn();

      await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);
      const text = callback.mock.calls[0][0].text;
      expect(text).not.toContain("Endpoint Health");
      expect(text).not.toContain("Fidelity Score");
    });

    it("shows price when greater than 0", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ serviceInfo: { description: "", priceUSD: 0.01, network: "base", wallet: null, hasSchema: true, lastUpdated: "" } })
      );
      const callback = vi.fn();

      await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);
      expect(callback.mock.calls[0][0].text).toContain("$0.01");
    });

    it("omits price when zero", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse({ serviceInfo: { description: "", priceUSD: 0, network: "base", wallet: null, hasSchema: true, lastUpdated: "" } })
      );
      const callback = vi.fn();

      await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);
      expect(callback.mock.calls[0][0].text).not.toContain("Price");
    });

    it("shows flags when present", async () => {
      mockClient.getServiceScore.mockResolvedValue(makeScoreResponse({ flags: ["WALLET_SPAM_FARM", "NO_SCHEMA"] }));
      const callback = vi.fn();

      await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);
      expect(callback.mock.calls[0][0].text).toContain("Flags");
    });

    it("handles 404 error with domain-specific message", async () => {
      const err = new ScoutApiError("Not found", 404);
      mockClient.getServiceScore.mockRejectedValue(err);
      const callback = vi.fn();

      const result = await checkServiceAction.handler(runtime, makeMessage("check missing.com"), undefined, undefined, callback);
      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("not found");
    });

    it("handles generic API error", async () => {
      const err = new ScoutApiError("Server error", 500);
      mockClient.getServiceScore.mockRejectedValue(err);
      const callback = vi.fn();

      const result = await checkServiceAction.handler(runtime, makeMessage("check test.com"), undefined, undefined, callback);
      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("Failed to check");
    });

    it("returns failure when no domain found", async () => {
      const callback = vi.fn();
      const result = await checkServiceAction.handler(runtime, makeMessage("check something"), undefined, undefined, callback);
      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("couldn't find a domain");
    });

    it("returns failure when client not initialized", async () => {
      const bareRuntime = makeRuntime();
      const callback = vi.fn();
      const result = await checkServiceAction.handler(bareRuntime, makeMessage("check test.com"), undefined, undefined, callback);
      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("not properly initialized");
    });
  });
});