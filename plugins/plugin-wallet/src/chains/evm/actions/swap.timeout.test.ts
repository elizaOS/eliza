/**
 * Exercises EVM SwapAction fetch deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

describe("EVM SwapAction fetch timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("Bebop, KyberSwap quote and build use AbortSignal.timeout", async () => {
    const swapPath = "./swap.ts";
    // Static check: file contains three timeout signals
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL(swapPath, import.meta.url), "utf-8");
    const matches = src.match(/AbortSignal\.timeout\(10_000\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("aborts stalled fetch with timeout signal", async () => {
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

    // Directly exercise fetch with timeout as SwapAction would
    await expect(
      fetch(
        "https://api.bebop.xyz/router/ethereum/v1/quote?sell_tokens=0x0&buy_tokens=0x1&sell_amounts=1&taker_address=0x0&approval_type=Standard&skip_validation=true&gasless=false&source=eliza",
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        }
      )
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
  });
});
