/**
 * Exercises RaydiumService fetch deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS, RaydiumService } from "./srv_raydium";

const originalFetch = globalThis.fetch;

describe("RaydiumService fetch timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exposes timeout constant", () => {
    expect(DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts stalled getQuote at timeout", async () => {
    const svc = Object.create(RaydiumService.prototype) as RaydiumService;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(10));

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.getQuote({ inputMint: "So111", outputMint: "EPjFW", amount: 100, slippageBps: 50 })
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.raydium.io/v2/main/quote"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("aborts stalled getTokenPair at timeout", async () => {
    const svc = Object.create(RaydiumService.prototype) as RaydiumService;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(10));

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.getTokenPair({ inputMint: "A", outputMint: "B" })).rejects.toMatchObject({
      name: "TimeoutError",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.raydium.io/v2/main/pairs/"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
