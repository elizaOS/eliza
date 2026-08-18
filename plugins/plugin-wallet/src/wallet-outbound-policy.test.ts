/**
 * Wallet outbound-request policy — unified timeout coverage.
 * Verifies Raydium (4 routes), Steer (2 routes), KaminoLiquidity, and Jupiter
 * wrapper all abort on timeout and respect caller signals.
 */

import http from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { KaminoLiquidityService } from "./analytics/lpinfo/kamino/services/kaminoLiquidityService.ts";
import { SteerLiquidityService } from "./analytics/lpinfo/steer/services/steerLiquidityService.ts";
import { RaydiumService } from "./chains/solana/dex/raydium/services/srv_raydium.ts";
import {
  DEFAULT_JUPITER_FETCH_TIMEOUT_MS,
  fetchJupiterJson,
} from "./chains/solana/jupiter-api.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("wallet outbound timeout policy", () => {
  let hangingServer: http.Server;
  let hangingUrl: string;

  beforeAll(async () => {
    hangingServer = http.createServer((_req, _res) => {});
    await new Promise<void>((resolve) =>
      hangingServer.listen(0, "127.0.0.1", resolve),
    );
    const addr = hangingServer.address() as { port: number };
    hangingUrl = `http://127.0.0.1:${addr.port}/hang`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("real HTTP boundary aborts on timeout", async () => {
    await expect(
      fetch(hangingUrl, { signal: AbortSignal.timeout(10) }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("jupiter timeout constant is 10_000", () => {
    expect(DEFAULT_JUPITER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("raydium getQuote aborts and sends signal", async () => {
    const svc = new RaydiumService();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(
      svc.getQuote({
        inputMint: "So111",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1,
        slippageBps: 100,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("api.raydium.io"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("raydium other routes abort", async () => {
    const svc = new RaydiumService();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(
      svc.getTokenPair({ inputMint: "So111", outputMint: "EPjFW" }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      svc.getHistoricalPrices({ inputMint: "So111", outputMint: "EPjFW" }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      svc.executeSwap({
        quoteResponse: {} as never,
        userPublicKey: "11111111111111111111111111111111",
        slippageBps: 100,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("jupiter fetch wrapper merges caller signal and times out", async () => {
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const caller = new AbortController();
    const hangingFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    await expect(
      fetchJupiterJson(
        hangingFetch as unknown as typeof fetch,
        "http://example.com/quote",
        "quote",
      ),
    ).rejects.toMatchObject({ code: "JUPITER_QUOTE_TRANSPORT_FAILED" });
    expect(hangingFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const anySpy = vi.spyOn(AbortSignal, "any");
    hangingFetch.mockClear();
    anySpy.mockClear();
    await expect(
      fetchJupiterJson(
        hangingFetch as unknown as typeof fetch,
        "http://example.com/quote",
        "quote",
        { signal: caller.signal },
      ),
    ).rejects.toMatchObject({ code: "JUPITER_QUOTE_TRANSPORT_FAILED" });
    expect(anySpy).toHaveBeenCalled();
  });

  it("steer GraphQL routes abort and send signal", async () => {
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing steer");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const svc = new SteerLiquidityService({} as never);
    // testGraphQLConnection should abort
    await expect(svc.testGraphQLConnection()).resolves.toMatchObject({
      success: false,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    spy.mockClear();
    // testGraphQLVaultQuery also aborts via inner getVaultDataFromGraphQL
    await expect(svc.testGraphQLVaultQuery("0x123")).resolves.toMatchObject({
      success: false,
    });
    expect(spy).toHaveBeenCalled();
  });

  it("kaminoLiquidity makeApiRequest aborts", async () => {
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing kaminoLiquidity");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const svc = Object.create(
      KaminoLiquidityService.prototype,
    ) as KaminoLiquidityService;
    (svc as unknown as { apiBaseUrl: string }).apiBaseUrl =
      "https://kamino.test";
    await expect(
      (
        svc as unknown as { getStakingYields: () => Promise<unknown> }
      ).getStakingYields(),
    ).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("kamino.test"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
