/**
 * Exercises KaminoLiquidityService fetch deadline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KaminoLiquidityService } from "./kaminoLiquidityService";

const originalFetch = globalThis.fetch;

describe("KaminoLiquidityService timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("aborts stalled makeApiRequest at timeout", async () => {
    const svc = Object.create(
      KaminoLiquidityService.prototype,
    ) as KaminoLiquidityService;
    (svc as unknown as { apiBaseUrl: string }).apiBaseUrl =
      "https://kamino.test";

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
      (
        svc as unknown as { makeApiRequest: (e: string) => Promise<unknown> }
      ).makeApiRequest("/test"),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://kamino.test/test"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
