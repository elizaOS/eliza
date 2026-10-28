/**
 * A failed Birdeye trending page must not be reported (and then cached) as an
 * empty trending list. The service fetches the ranking in `BATCH_SIZE` pages
 * with `Promise.allSettled`, so a 429/5xx on every page used to resolve as
 * `{ data: [] }` — callers could not tell "Birdeye is down" from "no trending
 * tokens", and the empty list was written to the cache for the whole TTL.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { BirdeyeService } from "./service";

type RuntimeHarness = {
  runtime: IAgentRuntime;
  cached: Array<{ key: string; value: unknown }>;
};

function createRuntime(port: number): RuntimeHarness {
  const cached: Array<{ key: string; value: unknown }> = [];
  const runtime = {
    getSetting: (key: string) => {
      if (key === "BIRDEYE_API_KEY") return null;
      if (key === "ELIZAOS_CLOUD_API_KEY") return "test-cloud-key";
      if (key === "ELIZAOS_CLOUD_ENABLED") return true;
      if (key === "ELIZAOS_CLOUD_BASE_URL") return `http://127.0.0.1:${port}`;
      return undefined;
    },
    getCache: async () => undefined,
    setCache: async (key: string, value: unknown) => {
      cached.push({ key, value });
    },
    logger: {
      debug: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
    },
  } as unknown as IAgentRuntime;
  return { runtime, cached };
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function tokenPage(address: string) {
  return {
    data: {
      updateUnixTime: 1_700_000_000,
      tokens: [
        {
          address,
          symbol: "TKN",
          name: "Token",
          price: 1,
          rank: 1,
        },
      ],
    },
  };
}

describe("BirdeyeService trending pagination failures", () => {
  it("reports a rejected request instead of an empty trending list", async () => {
    const port = await listen((req, res) => {
      expect(req.url).toContain("defi/token_trending");
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "rate limited" }));
    });
    const { runtime, cached } = createRuntime(port);
    const service = new BirdeyeService(runtime);

    await expect(
      service.getTrendingTokensForChain("solana", { total: 40 }),
    ).rejects.toThrow(/HTTP 429/);
    expect(cached).toEqual([]);
  });

  it("returns the pages that succeeded without caching a truncated ranking", async () => {
    let call = 0;
    const port = await listen((_req, res) => {
      call += 1;
      if (call === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            tokenPage("So11111111111111111111111111111111111111112"),
          ),
        );
        return;
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "unavailable" }));
    });
    const { runtime, cached } = createRuntime(port);
    const service = new BirdeyeService(runtime);

    const wrapper = await service.getTrendingTokensForChain("solana", {
      total: 40,
    });
    expect(wrapper.data).toHaveLength(1);
    expect(wrapper.data[0]?.address).toBe(
      "So11111111111111111111111111111111111111112",
    );
    expect(cached).toEqual([]);
  });

  it("still caches the list when every page succeeds", async () => {
    let call = 0;
    const port = await listen((_req, res) => {
      call += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          tokenPage(
            call === 1
              ? "So11111111111111111111111111111111111111112"
              : "So22222222222222222222222222222222222222222",
          ),
        ),
      );
    });
    const { runtime, cached } = createRuntime(port);
    const service = new BirdeyeService(runtime);

    const wrapper = await service.getTrendingTokensForChain("solana", {
      total: 40,
    });
    expect(wrapper.data).toHaveLength(2);
    expect(cached).toHaveLength(1);
    expect(cached[0]?.key).toBe("tokens_v2_solana");
  });
});
