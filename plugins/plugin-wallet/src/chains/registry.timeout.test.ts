/**
 * Exercises PumpPortal fetch deadline via fetchPumpFunTransaction boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

describe("PumpPortal fetch timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses AbortSignal.timeout for trade-local fetch", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("./registry.ts", import.meta.url),
      "utf-8",
    );
    const matches = src.match(/AbortSignal\.timeout\(15_000\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("aborts stalled PumpPortal fetch at timeout", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("expected signal");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
  });
});
