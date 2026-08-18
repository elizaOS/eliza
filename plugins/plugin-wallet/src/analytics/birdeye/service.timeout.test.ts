/**
 * Exercises BirdeyeService fetch deadline via injected fetch boundary.
 * Verifies getBirdeyeFetchOptions propagates AbortSignal.timeout and that
 * fetchBirdeyeJson aborts a stalled upstream.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BIRDEYE_FETCH_TIMEOUT_MS } from "./constants";
import { BirdeyeService } from "./service";

const originalFetch = globalThis.fetch;

describe("BirdeyeService fetch timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("includes AbortSignal.timeout in getBirdeyeFetchOptions", () => {
    const service = Object.create(BirdeyeService.prototype) as BirdeyeService;
    // @ts-expect-error private access for test
    (
      service as unknown as { access: { headers: Record<string, string> } }
    ).access = {
      headers: {},
    };
    // @ts-expect-error private
    const opts = service.getBirdeyeFetchOptions("solana");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.headers).toMatchObject({ "x-chain": "solana" });
    expect((opts.signal as AbortSignal).aborted).toBe(false);
  });

  it("aborts a stalled fetchBirdeyeJson at the configured deadline", async () => {
    const service = Object.create(BirdeyeService.prototype) as BirdeyeService;
    (
      service as unknown as {
        access: { baseUrl: string; headers: Record<string, string> };
      }
    ).access = {
      baseUrl: "https://birdeye.test",
      headers: {},
    };
    (service as unknown as { birdeyeUrl: (p: string) => string }).birdeyeUrl = (
      p: string,
    ) => `https://birdeye.test/${p.replace(/^\/+/, "")}`;

    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) throw new Error("expected abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      // @ts-expect-error private
      service.fetchBirdeyeJson("/defi/price", { address: "So111" }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://birdeye.test/defi/price"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("uses timeout constant from constants", () => {
    expect(DEFAULT_BIRDEYE_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});
