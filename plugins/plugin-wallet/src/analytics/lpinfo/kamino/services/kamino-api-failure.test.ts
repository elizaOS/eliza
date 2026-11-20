/**
 * A Kamino REST API failure (429/5xx/timeout) was caught inside the list
 * fetchers and folded into `[]`, so the connection probe reported
 * `connectionTest: true` during an outage and `getMarketStatistics()` returned
 * a "successful" snapshot whose APYs were NaN/-Infinity (0/0, Math.max(...[])).
 * Callers must be able to tell "the market really is empty" from "we could not
 * ask the market".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KaminoLiquidityService } from "./kaminoLiquidityService.js";

function service(): KaminoLiquidityService {
  const instance = Object.create(
    KaminoLiquidityService.prototype,
  ) as KaminoLiquidityService & { apiBaseUrl: string };
  instance.apiBaseUrl = "https://kamino.test";
  return instance;
}

function stubFetchStatus(status: number): void {
  vi.stubGlobal(
    "fetch",
    async () => new Response("upstream failed", { status }),
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answers every Kamino endpoint with a well-formed payload. */
function stubFetchOk(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v2/staking-yields/median")) {
      return jsonResponse([{ apy: "0.05", tokenMint: "medianMint" }]);
    }
    if (url.includes("/v2/staking-yields")) {
      return jsonResponse([{ apy: "0.04", tokenMint: "mint" }]);
    }
    if (url.includes("/limo/trades")) {
      return jsonResponse([
        {
          sizeUsd: "10",
          tipAmountUsd: "0.1",
          surplusUsd: "0.2",
          inMint: "inMint",
          outMint: "outMint",
        },
      ]);
    }
    return new Response("unknown endpoint", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kamino REST API failure", () => {
  it("reports a failed connection when the API returns 503", async () => {
    stubFetchStatus(503);

    const result = await service().testConnection();

    expect(result.connectionTest).toBe(false);
    expect(result.stakingYieldsTest).toBe(false);
    expect(result.limoTradesTest).toBe(false);
  });

  it("does not fabricate market statistics while rate limited", async () => {
    stubFetchStatus(429);

    const stats = await service().getMarketStatistics();

    expect(stats).toBeNull();
  });

  it("rejects with the HTTP status rather than a bare failure", async () => {
    stubFetchStatus(503);

    await expect(service().getStakingYieldsStrict()).rejects.toThrow(/503/);
  });

  it("reports a healthy API as connected (positive control)", async () => {
    stubFetchOk();

    const result = await service().testConnection();

    expect(result.connectionTest).toBe(true);
    expect(result.stakingYieldsTest).toBe(true);
    expect(result.limoTradesTest).toBe(true);
  });

  it("returns real statistics when the API answers (positive control)", async () => {
    stubFetchOk();

    const stats = await service().getMarketStatistics();

    expect(stats).not.toBeNull();
    expect(stats?.stakingYields.total).toBe(1);
    expect(stats?.stakingYields.averageApy).toBeCloseTo(4);
    expect(stats?.limoTrades.totalVolume).toBeCloseTo(10);
  });
});
