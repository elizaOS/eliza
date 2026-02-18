import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { trustContextProvider } from "./trust-context.js";
import { setScoutClient } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";
import type { ServiceScoreResponse } from "../client/types.js";

function makeRuntime(): IAgentRuntime {
  return { agentId: "agent-1" } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return { content: { text }, userId: "u", agentId: "a", roomId: "r" } as Memory;
}

function makeScoreResponse(domain: string, overrides: Partial<ServiceScoreResponse> = {}): ServiceScoreResponse {
  return {
    success: true,
    domain,
    resourceUrl: `https://${domain}/api`,
    score: 80,
    level: "HIGH",
    dimensions: { contractClarity: 80, availability: 90, responseFidelity: 70, identitySafety: 80 },
    flags: [],
    recommendation: {
      verdict: "RECOMMENDED",
      message: "Trusted",
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

describe("trustContextProvider", () => {
  it("returns empty text when client not set", async () => {
    const runtime = makeRuntime();
    const result = await trustContextProvider.get(runtime, makeMessage("check test.com"), {} as State);
    expect(result).toEqual({ text: "" });
  });

  it("returns empty text when no domains in message", async () => {
    const runtime = makeRuntime();
    setScoutClient(runtime, { getServiceScore: vi.fn() } as unknown as ScoutClient);

    const result = await trustContextProvider.get(runtime, makeMessage("hello world"), {} as State);
    expect(result).toEqual({ text: "" });
  });

  describe("with mock client", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getServiceScore: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getServiceScore: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("returns trust context for a single domain", async () => {
      mockClient.getServiceScore.mockResolvedValue(makeScoreResponse("test.com"));

      const result = await trustContextProvider.get(runtime, makeMessage("what about test.com?"), {} as State);

      expect(result.text).toContain("Trust context for test.com");
      expect(result.text).toContain("Score 80/100 (HIGH)");
      expect(result.text).toContain("Contract 80");
      expect(result.text).toContain("Verdict: RECOMMENDED (max $5000)");
      expect(result.values.scoutTrustData).toHaveProperty("test.com");
      expect(result.values.scoutTrustData["test.com"].score).toBe(80);
    });

    it("includes endpoint health when present", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse("test.com", {
          endpointHealth: { status: "UP", statusCode: 402, latencyMs: 100, lastChecked: "" },
        })
      );

      const result = await trustContextProvider.get(runtime, makeMessage("check test.com"), {} as State);

      expect(result.text).toContain("Health: UP (100ms)");
      expect(result.values.scoutTrustData["test.com"].health).toBe("UP");
    });

    it("shows UNKNOWN health when endpointHealth absent", async () => {
      mockClient.getServiceScore.mockResolvedValue(makeScoreResponse("test.com"));

      const result = await trustContextProvider.get(runtime, makeMessage("check test.com"), {} as State);

      expect(result.values.scoutTrustData["test.com"].health).toBe("UNKNOWN");
    });

    it("includes flags when present", async () => {
      mockClient.getServiceScore.mockResolvedValue(
        makeScoreResponse("test.com", { flags: ["WALLET_SPAM_FARM"] })
      );

      const result = await trustContextProvider.get(runtime, makeMessage("check test.com"), {} as State);

      expect(result.text).toContain("WALLET_SPAM_FARM");
    });

    it("limits to 3 domains max", async () => {
      mockClient.getServiceScore.mockImplementation((domain: string) =>
        Promise.resolve(makeScoreResponse(domain))
      );

      const result = await trustContextProvider.get(
        runtime,
        makeMessage("compare a.com, b.com, c.com, and d.com"),
        {} as State
      );

      expect(mockClient.getServiceScore).toHaveBeenCalledTimes(3);
      const data = result.values.scoutTrustData;
      expect(Object.keys(data).length).toBe(3);
    });

    it("handles API errors gracefully with fallback text", async () => {
      mockClient.getServiceScore.mockRejectedValue(new Error("API down"));

      const result = await trustContextProvider.get(runtime, makeMessage("check test.com"), {} as State);

      expect(result.text).toContain("Unable to fetch");
      expect(result.text).toContain("test.com");
    });

    it("handles mixed success and failure", async () => {
      let callCount = 0;
      mockClient.getServiceScore.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(makeScoreResponse("good.com"));
        return Promise.reject(new Error("Not found"));
      });

      const result = await trustContextProvider.get(
        runtime,
        makeMessage("check good.com and bad.com"),
        {} as State
      );

      expect(result.text).toContain("Score 80/100");
      expect(result.text).toContain("Unable to fetch");
    });
  });
});