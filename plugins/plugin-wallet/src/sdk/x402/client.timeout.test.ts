/**
 * Exercises X402Client fetch deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_X402_FETCH_TIMEOUT_MS, X402Client } from "./client";

describe("X402Client fetch timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes timeout constant", () => {
    expect(DEFAULT_X402_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("injects AbortSignal.timeout when no signal provided", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(10));

    const mockWallet = {
      address: "0x0000000000000000000000000000000000000000",
    } as unknown as import("../wallet-core.js").AgentWallet;

    const client = new X402Client(mockWallet as never);

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        client.fetch("https://example.com/api"),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(DEFAULT_X402_FETCH_TIMEOUT_MS);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves caller-provided signal", async () => {
    const mockWallet = {
      address: "0x0000000000000000000000000000000000000000",
    } as unknown as import("../wallet-core.js").AgentWallet;

    const client = new X402Client(mockWallet as never);
    const controller = new AbortController();

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const res = await client.fetch("https://example.com/api", {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: controller.signal }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
