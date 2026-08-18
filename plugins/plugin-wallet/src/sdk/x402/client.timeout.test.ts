/**
 * Exercises X402Client fetch deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { X402Client } from "./client";

const originalFetch = globalThis.fetch;

describe("X402Client timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("aborts stalled fetch at timeout", async () => {
    const wallet = { address: "0x123" } as unknown as X402Client["wallet"];
    const client = new X402Client(wallet, {});

    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(client.fetch("https://api.test/data")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.test/data"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("exposes DEFAULT_X402_FETCH_TIMEOUT_MS constant", async () => {
    const { DEFAULT_X402_FETCH_TIMEOUT_MS } = await import("./client");
    expect(DEFAULT_X402_FETCH_TIMEOUT_MS).toBe(15_000);
  });
});
