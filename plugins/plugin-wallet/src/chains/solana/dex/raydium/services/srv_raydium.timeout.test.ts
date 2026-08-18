/**
 * Exercises RaydiumService fetch deadlines.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS, RaydiumService } from "./srv_raydium";

const originalFetch = globalThis.fetch;

describe("RaydiumService timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exposes timeout constant", () => {
    expect(DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts stalled getQuote at timeout", async () => {
    const svc = new RaydiumService(undefined as unknown as never);
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(10));

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = (_init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.getQuote({ inputMint: "a", outputMint: "b", amount: 1, slippageBps: 50 })
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.raydium.io"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("aborts stalled getTokenPair at timeout", async () => {
    const svc = new RaydiumService(undefined as unknown as never);
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(10));

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = (_init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.getTokenPair({ inputMint: "a", outputMint: "b" })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});
