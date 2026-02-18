import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { browseLeaderboardAction } from "./browse-leaderboard.js";
import { setScoutClient } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";
import type { LeaderboardResponse } from "../client/types.js";

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

function makeLeaderboardResponse(overrides: Partial<LeaderboardResponse> = {}): LeaderboardResponse {
  return {
    success: true,
    stats: {
      totalServices: 100,
      legitimateServices: 80,
      uniqueWallets: 50,
      avgServiceScore: 65,
      serviceDistribution: { HIGH: 20, MEDIUM: 40, LOW: 30, VERY_LOW: 10 },
      platforms: ["base"],
      categoryCounts: {},
      sourceCounts: {},
    },
    services: [
      {
        rank: 1,
        domain: "best.com",
        description: "Best service",
        score: 90,
        level: "HIGH",
        hasSchema: true,
        priceUSD: 0.01,
        network: "base",
        serviceCount: 1,
        category: "AI & ML",
        verified: false,
        source: "x402_bazaar",
        liveness: "UP",
        latencyMs: 100,
        lastChecked: "",
        fidelity: null,
        flags: [],
        platform: "base",
      },
    ],
    _meta: { limit: 10, offset: 0, tier: "free", dataSource: ["bazaar"], timestamp: "" },
    ...overrides,
  };
}

describe("browseLeaderboardAction", () => {
  describe("validate", () => {
    const runtime = makeRuntime();

    it("returns true for 'leaderboard'", async () => {
      expect(await browseLeaderboardAction.validate(runtime, makeMessage("show me the leaderboard"))).toBe(true);
    });

    it("returns true for 'top services'", async () => {
      expect(await browseLeaderboardAction.validate(runtime, makeMessage("show top services"))).toBe(true);
    });

    it("returns true for 'find services'", async () => {
      expect(await browseLeaderboardAction.validate(runtime, makeMessage("find services for me"))).toBe(true);
    });

    it("returns true for 'discover'", async () => {
      expect(await browseLeaderboardAction.validate(runtime, makeMessage("discover new services"))).toBe(true);
    });

    it("returns true for 'trusted services'", async () => {
      expect(await browseLeaderboardAction.validate(runtime, makeMessage("what are the trusted services?"))).toBe(true);
    });

    it("returns false for unrelated message", async () => {
      expect(await browseLeaderboardAction.validate(runtime, makeMessage("check test.com trust score"))).toBe(false);
    });
  });

  describe("handler - parseLeaderboardIntent", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getLeaderboard: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getLeaderboard: vi.fn().mockResolvedValue(makeLeaderboardResponse()) };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("parses exact category match", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("show AI & ML leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ category: "AI & ML" })
      );
    });

    it("parses shorthand 'ai' keyword to AI & ML", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("show me top ai services on the leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ category: "AI & ML" })
      );
    });

    it("parses shorthand 'trading' keyword to Trading & DeFi", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("discover trading services"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Trading & DeFi" })
      );
    });

    it("parses shorthand 'nft' keyword to Tokens & NFTs", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("find nft services on the leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Tokens & NFTs" })
      );
    });

    it("parses shorthand 'data' keyword to Data & Analytics", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("top data services leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Data & Analytics" })
      );
    });

    it("parses shorthand 'social' keyword to Social Media", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("discover social services"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Social Media" })
      );
    });

    it("parses shorthand 'storage' keyword to Storage & Files", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("find storage services on the leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Storage & Files" })
      );
    });

    it("parses quoted search terms", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage('find services "weather api" on the leaderboard'), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ search: "weather api" })
      );
    });

    it("parses 'top N' limit", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("show top 5 services on the leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 })
      );
    });

    it("caps limit at 50", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("show top 100 services on the leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 })
      );
    });

    it("defaults limit to 10", async () => {
      await browseLeaderboardAction.handler(
        runtime, makeMessage("show the leaderboard"), undefined, undefined, vi.fn()
      );
      expect(mockClient.getLeaderboard).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 })
      );
    });
  });

  describe("handler - output formatting", () => {
    let runtime: IAgentRuntime;
    let mockClient: { getLeaderboard: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { getLeaderboard: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("formats service list with rank, score, health, price", async () => {
      mockClient.getLeaderboard.mockResolvedValue(makeLeaderboardResponse());
      const callback = vi.fn();

      await browseLeaderboardAction.handler(
        runtime, makeMessage("show the leaderboard"), undefined, undefined, callback
      );

      const text = callback.mock.calls[0][0].text;
      expect(text).toContain("Scout Service Leaderboard");
      expect(text).toContain("100 total services");
      expect(text).toContain("1. **best.com**");
      expect(text).toContain("90/100");
      expect(text).toContain("UP");
      expect(text).toContain("$0.01");
    });

    it("shows 'Free' for zero-price services", async () => {
      const resp = makeLeaderboardResponse();
      resp.services[0].priceUSD = 0;
      mockClient.getLeaderboard.mockResolvedValue(resp);
      const callback = vi.fn();

      await browseLeaderboardAction.handler(
        runtime, makeMessage("show the leaderboard"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("Free");
    });

    it("shows description when available", async () => {
      mockClient.getLeaderboard.mockResolvedValue(makeLeaderboardResponse());
      const callback = vi.fn();

      await browseLeaderboardAction.handler(
        runtime, makeMessage("show the leaderboard"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("Best service");
    });

    it("shows 'no services found' for empty results", async () => {
      mockClient.getLeaderboard.mockResolvedValue(makeLeaderboardResponse({ services: [] }));
      const callback = vi.fn();

      await browseLeaderboardAction.handler(
        runtime, makeMessage("show the leaderboard"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("No services found");
    });

    it("includes category in header when filtered", async () => {
      mockClient.getLeaderboard.mockResolvedValue(makeLeaderboardResponse());
      const callback = vi.fn();

      await browseLeaderboardAction.handler(
        runtime, makeMessage("show AI & ML leaderboard"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("AI & ML");
    });

    it("handles API error", async () => {
      mockClient.getLeaderboard.mockRejectedValue(new Error("Down"));
      const callback = vi.fn();

      const result = await browseLeaderboardAction.handler(
        runtime, makeMessage("show the leaderboard"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("Failed to fetch leaderboard");
    });

    it("returns failure when client not initialized", async () => {
      const bareRuntime = makeRuntime();
      const callback = vi.fn();
      const result = await browseLeaderboardAction.handler(
        bareRuntime, makeMessage("show the leaderboard"), undefined, undefined, callback
      );
      expect(result).toEqual({ success: false });
    });
  });
});