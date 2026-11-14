/**
 * A non-OK Birdeye answer for a single token used to be parsed and stored like
 * a successful payload: `getTokenTradeData`/`getTokenSecurityData` awaited
 * `resp.json()` without checking `resp.ok`, so a 401/429 error body
 * (`{ success: false, message: "..." }`) was truthy, written to the cache for
 * the 30-minute TTL, and returned as `TokenTradeDataSingleResponse`. Callers
 * asking for `data.items` got a field-less object they could not tell from a
 * real answer, and the transient failure stayed sticky for the whole TTL.
 *
 * The rest of the service already treats a non-OK response as a failure
 * (`fetchBirdeyeJson` throws `Birdeye API error <status>`), and the declared
 * failure signal of these two methods is `false`.
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
      log: () => {},
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

describe("BirdeyeService single-token error payloads", () => {
  it("resolves trade data as a failure instead of caching the 401 body", async () => {
    const port = await listen((req, res) => {
      expect(req.url).toContain("defi/v3/token/trade-data/single");
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "invalid api key" }));
    });
    const { runtime, cached } = createRuntime(port);
    const service = new BirdeyeService(runtime);

    const result = await service.getTokenTradeData(
      "solana",
      "So11111111111111111111111111111111111111112",
    );

    expect(result).toBe(false);
    expect(cached).toEqual([]);
  });

  it("resolves security data as a failure instead of caching the 429 body", async () => {
    const port = await listen((req, res) => {
      expect(req.url).toContain("defi/token_security");
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "rate limited" }));
    });
    const { runtime, cached } = createRuntime(port);
    const service = new BirdeyeService(runtime);

    const result = await service.getTokenSecurityData(
      "solana",
      "So11111111111111111111111111111111111111112",
    );

    expect(result).toBe(false);
    expect(cached).toEqual([]);
  });

  it("still returns and caches a successful answer", async () => {
    const payload = {
      data: {
        address: "So11111111111111111111111111111111111111112",
        volumeUSD: 42,
        frames: ["2h"],
      },
    };
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    const { runtime, cached } = createRuntime(port);
    const service = new BirdeyeService(runtime);

    const result = await service.getTokenTradeData(
      "solana",
      "So11111111111111111111111111111111111111112",
    );

    expect(result).toEqual(payload);
    expect(cached).toHaveLength(1);
  });
});
