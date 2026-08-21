/**
 * Deterministic coverage for the browser-bridge request deadline, including a
 * transport that ignores AbortSignal so background sync cannot remain wedged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserBridgeRequestTimeout } from "./request-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withBrowserBridgeRequestTimeout", () => {
  it("returns successful operations and clears their deadline", async () => {
    vi.useFakeTimers();
    await expect(
      withBrowserBridgeRequestTimeout(
        "relay sync",
        async (signal) => {
          expect(signal.aborted).toBe(false);
          return "ok";
        },
        25,
      ),
    ).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and rejects when a transport ignores cancellation", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null = null;
    const request = withBrowserBridgeRequestTimeout(
      "relay sync",
      async (signal) => {
        observedSignal = signal;
        return new Promise<never>(() => undefined);
      },
      25,
    );
    const rejection = expect(request).rejects.toThrow(
      "relay sync timed out after 25 ms",
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an operation failure before the deadline", async () => {
    vi.useFakeTimers();
    const failure = new Error("relay rejected the pairing");
    await expect(
      withBrowserBridgeRequestTimeout(
        "relay sync",
        async () => {
          throw failure;
        },
        25,
      ),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid timeout configuration", async () => {
    await expect(
      withBrowserBridgeRequestTimeout("relay sync", async () => "ok", 0),
    ).rejects.toThrow("positive finite number");
  });
});
