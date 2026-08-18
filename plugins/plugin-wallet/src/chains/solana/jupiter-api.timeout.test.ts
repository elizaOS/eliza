/**
 * Exercises fetchJupiterJson deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JUPITER_FETCH_TIMEOUT_MS, fetchJupiterJson } from "./jupiter-api";

describe("fetchJupiterJson timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes timeout constant", () => {
    expect(DEFAULT_JUPITER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("injects AbortSignal.timeout when no signal provided", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(10));

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });

    await expect(
      fetchJupiterJson(
        fetchMock as unknown as typeof fetch,
        "https://lite-api.jup.ag/swap/v1/quote?x=1",
        "quote"
      )
    ).rejects.toMatchObject({
      code: "JUPITER_QUOTE_TRANSPORT_FAILED",
    });

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_JUPITER_FETCH_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://lite-api.jup.ag"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("preserves caller-provided signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await fetchJupiterJson(
      fetchMock as unknown as typeof fetch,
      "https://lite-api.jup.ag/swap/v1/quote?x=1",
      "quote",
      {
        signal: controller.signal,
      }
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal })
    );
  });
});
