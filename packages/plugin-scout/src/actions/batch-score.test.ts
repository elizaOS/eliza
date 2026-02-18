import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { batchScoreAction } from "./batch-score.js";
import { setScoutClient } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";

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

describe("batchScoreAction", () => {
  describe("validate", () => {
    const runtime = makeRuntime();

    it("returns true when 2+ domains present", async () => {
      expect(await batchScoreAction.validate(runtime, makeMessage("compare test.com and example.org"))).toBe(true);
    });

    it("returns false with only 1 domain", async () => {
      expect(await batchScoreAction.validate(runtime, makeMessage("check test.com"))).toBe(false);
    });

    it("returns false with no domains", async () => {
      expect(await batchScoreAction.validate(runtime, makeMessage("compare services"))).toBe(false);
    });
  });

  describe("handler", () => {
    let runtime: IAgentRuntime;
    let mockClient: { batchScore: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      runtime = makeRuntime();
      mockClient = { batchScore: vi.fn() };
      setScoutClient(runtime, mockClient as unknown as ScoutClient);
    });

    it("returns formatted batch results sorted by score", async () => {
      mockClient.batchScore.mockResolvedValue({
        batch: { total: 2, scored: 2, notFound: 0, averageScore: 70, distribution: { HIGH: 1, MEDIUM: 1, LOW: 0, VERY_LOW: 0 } },
        results: [
          { domain: "low.com", score: 60, level: "MEDIUM", flags: [] },
          { domain: "high.com", score: 80, level: "HIGH", flags: [] },
        ],
      });
      const callback = vi.fn();

      const result = await batchScoreAction.handler(
        runtime, makeMessage("compare low.com and high.com"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: true, data: expect.any(Object) });
      const text = callback.mock.calls[0][0].text;
      // high.com should appear before low.com (sorted desc by score)
      const highIdx = text.indexOf("high.com");
      const lowIdx = text.indexOf("low.com");
      expect(highIdx).toBeLessThan(lowIdx);
      expect(text).toContain("2/2 found");
      expect(text).toContain("avg 70/100");
    });

    it("shows 'Not found' for null scores", async () => {
      mockClient.batchScore.mockResolvedValue({
        batch: { total: 2, scored: 1, notFound: 1, averageScore: 80, distribution: { HIGH: 1, MEDIUM: 0, LOW: 0, VERY_LOW: 0 } },
        results: [
          { domain: "found.com", score: 80, level: "HIGH" },
          { domain: "missing.com", score: null, level: null },
        ],
      });
      const callback = vi.fn();

      await batchScoreAction.handler(
        runtime, makeMessage("compare found.com and missing.com"), undefined, undefined, callback
      );

      const text = callback.mock.calls[0][0].text;
      expect(text).toContain("missing.com**: Not found");
    });

    it("shows flags for flagged services", async () => {
      mockClient.batchScore.mockResolvedValue({
        batch: { total: 2, scored: 2, notFound: 0, averageScore: 50, distribution: { HIGH: 0, MEDIUM: 1, LOW: 1, VERY_LOW: 0 } },
        results: [
          { domain: "a.com", score: 60, level: "MEDIUM", flags: [] },
          { domain: "b.com", score: 40, level: "LOW", flags: ["WALLET_SPAM_FARM"] },
        ],
      });
      const callback = vi.fn();

      await batchScoreAction.handler(
        runtime, makeMessage("compare a.com and b.com"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("WALLET_SPAM_FARM");
    });

    it("shows distribution when services are scored", async () => {
      mockClient.batchScore.mockResolvedValue({
        batch: { total: 2, scored: 2, notFound: 0, averageScore: 70, distribution: { HIGH: 1, MEDIUM: 1, LOW: 0, VERY_LOW: 0 } },
        results: [
          { domain: "a.com", score: 80, level: "HIGH" },
          { domain: "b.com", score: 60, level: "MEDIUM" },
        ],
      });
      const callback = vi.fn();

      await batchScoreAction.handler(
        runtime, makeMessage("compare a.com and b.com"), undefined, undefined, callback
      );

      expect(callback.mock.calls[0][0].text).toContain("Distribution");
    });

    it("rejects fewer than 2 domains", async () => {
      const callback = vi.fn();
      const result = await batchScoreAction.handler(
        runtime, makeMessage("check test.com"), undefined, undefined, callback
      );
      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("at least 2 domains");
    });

    it("rejects more than 20 domains", async () => {
      const domains = Array.from({ length: 21 }, (_, i) => `d${i}.com`).join(" and ");
      const callback = vi.fn();
      const result = await batchScoreAction.handler(
        runtime, makeMessage(`compare ${domains}`), undefined, undefined, callback
      );
      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("up to 20");
    });

    it("handles API error", async () => {
      mockClient.batchScore.mockRejectedValue(new Error("Server error"));
      const callback = vi.fn();

      const result = await batchScoreAction.handler(
        runtime, makeMessage("compare a.com and b.com"), undefined, undefined, callback
      );

      expect(result).toEqual({ success: false });
      expect(callback.mock.calls[0][0].text).toContain("Batch scoring failed");
    });

    it("returns failure when client not initialized", async () => {
      const bareRuntime = makeRuntime();
      const callback = vi.fn();
      const result = await batchScoreAction.handler(
        bareRuntime, makeMessage("compare a.com and b.com"), undefined, undefined, callback
      );
      expect(result).toEqual({ success: false });
    });
  });
});