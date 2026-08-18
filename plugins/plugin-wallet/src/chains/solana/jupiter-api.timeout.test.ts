/**
 * Jupiter fetch deadlines — proves the wrapper aborts on timeout via
 * mocked hanging fetch, covering both quote and swap stages.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_JUPITER_FETCH_TIMEOUT_MS, fetchJupiterJson } from "./jupiter-api";

describe("Jupiter fetch timeout", () => {
  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_JUPITER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled quote at the deadline", async () => {
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing jupiter quote");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    await expect(
      fetchJupiterJson(
        spy as unknown as typeof fetch,
        "https://lite-api.jup.ag/swap/v1/quote",
        "quote"
      )
    ).rejects.toMatchObject({ code: "JUPITER_QUOTE_TRANSPORT_FAILED" });
    // the cause should be TimeoutError
    try {
      await fetchJupiterJson(
        spy as unknown as typeof fetch,
        "https://lite-api.jup.ag/swap/v1/quote",
        "quote"
      );
    } catch (e) {
      expect((e as { cause?: { name?: string } }).cause?.name).toBe("TimeoutError");
    }
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("jup.ag"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    vi.restoreAllMocks();
  });

  it("merges a caller signal via AbortSignal.any", async () => {
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const anySpy = vi.spyOn(AbortSignal, "any");
    const controller = new AbortController();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing merge");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const pending = fetchJupiterJson(
      spy as unknown as typeof fetch,
      "https://lite-api.jup.ag/swap/v1/swap",
      "swap",
      {
        signal: controller.signal,
      }
    );
    controller.abort(new DOMException("caller abort", "AbortError"));
    await expect(pending).rejects.toMatchObject({ code: "JUPITER_SWAP_TRANSPORT_FAILED" });
    expect(anySpy).toHaveBeenCalledWith(
      expect.arrayContaining([controller.signal, expect.any(AbortSignal)])
    );
    vi.restoreAllMocks();
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      return Response.json({ outAmount: "1000" });
    });
    const result = await fetchJupiterJson(
      spy as unknown as typeof fetch,
      "https://lite-api.jup.ag/swap/v1/quote",
      "quote"
    );
    expect(result).toEqual({ outAmount: "1000" });
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const spy = vi.fn(async () => new Response("Service Unavailable", { status: 503 }));
    await expect(
      fetchJupiterJson(
        spy as unknown as typeof fetch,
        "https://lite-api.jup.ag/swap/v1/quote",
        "quote"
      )
    ).rejects.toMatchObject({ code: "JUPITER_QUOTE_HTTP_ERROR" });
  });
});
