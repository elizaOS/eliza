import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScoutClient, ScoutApiError } from "./scout-client.js";
import { ScoutCache } from "./cache.js";

function makeClient(opts: { apiKey?: string; agentId?: string } = {}) {
  const cache = new ScoutCache({ ttlMinutes: 5, maxEntries: 100 });
  return new ScoutClient(
    {
      baseUrl: "https://api.scoutscore.ai/",
      apiKey: opts.apiKey,
      agentId: opts.agentId,
    },
    cache
  );
}

function mockFetchOk(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockFetchError(status: number, body: { error?: string; details?: string } = {}) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("ScoutClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("getServiceScore", () => {
    it("fetches and caches service score", async () => {
      const mockData = { success: true, domain: "test.com", score: 80 };
      globalThis.fetch = mockFetchOk(mockData);

      const client = makeClient();
      const result = await client.getServiceScore("test.com");
      expect(result).toEqual(mockData);

      // Second call should use cache (fetch not called again)
      const result2 = await client.getServiceScore("test.com");
      expect(result2).toEqual(mockData);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("URL-encodes domain in path", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getServiceScore("test domain.com");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.scoutscore.ai/api/bazaar/score/test%20domain.com",
        expect.any(Object)
      );
    });

    it("strips trailing slash from baseUrl", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getServiceScore("test.com");
      const url = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(url).toBe("https://api.scoutscore.ai/api/bazaar/score/test.com");
      // No double slash between host and path
      const pathPart = url.replace("https://", "");
      expect(pathPart).not.toContain("//");
    });
  });

  describe("batchScore", () => {
    it("sends POST with domains", async () => {
      const mockData = { success: true, batch: {}, results: [] };
      globalThis.fetch = mockFetchOk(mockData);

      const client = makeClient();
      await client.batchScore(["a.com", "b.com"]);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.scoutscore.ai/api/bazaar/batch",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ domains: ["a.com", "b.com"] }),
        })
      );
    });
  });

  describe("getServiceFidelity", () => {
    it("appends fresh=true query param", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getServiceFidelity("test.com", true);
      const url = (globalThis.fetch as any).mock.calls[0][0];
      expect(url).toContain("?fresh=true");
    });

    it("omits query param when fresh is false", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getServiceFidelity("test.com", false);
      const url = (globalThis.fetch as any).mock.calls[0][0];
      expect(url).not.toContain("fresh");
    });
  });

  describe("getLeaderboard", () => {
    it("builds query params from options", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getLeaderboard({ category: "AI & ML", limit: 5 });
      const url = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain("category=AI+%26+ML");
      expect(url).toContain("limit=5");
    });

    it("caches based on query params", async () => {
      globalThis.fetch = mockFetchOk({ success: true, services: [] });
      const client = makeClient();
      await client.getLeaderboard({ category: "AI & ML" });
      await client.getLeaderboard({ category: "AI & ML" });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      // Different params = different cache key
      await client.getLeaderboard({ category: "Trading & DeFi" });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("getSkillScore", () => {
    it("encodes source and identifier", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getSkillScore("github", "owner/repo", { fetch: true });
      const url = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(url).toContain("/api/skill/score/github/owner%2Frepo");
      expect(url).toContain("fetch=true");
    });
  });

  describe("headers", () => {
    it("includes plugin version and action headers", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getServiceScore("test.com");
      const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
      expect(headers["X-Scout-Plugin-Version"]).toBe("0.1.0");
      expect(headers["X-Scout-Action"]).toBe("CHECK_SERVICE_TRUST");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("includes auth header when API key is set", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient({ apiKey: "sk-test" });
      await client.getServiceScore("test.com");
      const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBe("Bearer sk-test");
    });

    it("omits auth header when no API key", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient();
      await client.getServiceScore("test.com");
      const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("includes agent ID when set", async () => {
      globalThis.fetch = mockFetchOk({ success: true });
      const client = makeClient({ agentId: "agent-123" });
      await client.getServiceScore("test.com");
      const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
      expect(headers["X-Scout-Agent-Id"]).toBe("agent-123");
    });
  });

  describe("error handling", () => {
    it("throws ScoutApiError on HTTP error", async () => {
      globalThis.fetch = mockFetchError(404, { error: "Not found" });
      const client = makeClient();

      await expect(client.getServiceScore("test.com"))
        .rejects.toThrow(ScoutApiError);

      try {
        await client.getServiceScore("missing.com");
      } catch (err) {
        expect(err).toBeInstanceOf(ScoutApiError);
        expect((err as ScoutApiError).statusCode).toBe(404);
        expect((err as ScoutApiError).message).toBe("Not found");
      }
    });

    it("handles non-JSON error response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("invalid json")),
      });
      const client = makeClient();

      await expect(client.getServiceScore("test.com"))
        .rejects.toThrow("HTTP 500");
    });

    it("includes details from error response", async () => {
      globalThis.fetch = mockFetchError(422, {
        error: "Validation failed",
        details: "Missing domain",
      });
      const client = makeClient();

      try {
        await client.getServiceScore("test.com");
      } catch (err) {
        expect((err as ScoutApiError).details).toBe("Missing domain");
      }
    });
  });
});