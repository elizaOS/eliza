/**
 * Exercises SteerLiquidityService GraphQL fetch deadlines.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SteerLiquidityService } from "./steerLiquidityService";

const originalFetch = globalThis.fetch;

describe("SteerLiquidityService timeout", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("aborts stalled GraphQL connection at timeout", async () => {
    const svc = Object.create(
      SteerLiquidityService.prototype,
    ) as SteerLiquidityService;
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
    const result = await (
      svc as unknown as {
        testGraphQLConnection: () => Promise<{
          success: boolean;
          error?: string;
        }>;
      }
    ).testGraphQLConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TimeoutError|timeout|aborted/i);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
