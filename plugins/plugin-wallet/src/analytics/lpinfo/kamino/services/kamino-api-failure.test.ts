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
});
