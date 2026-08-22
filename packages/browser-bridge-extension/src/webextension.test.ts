/**
 * Adversarial tests for the browser API facade using callback- and
 * promise-style shims that never settle, matching extension-runtime hangs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_BRIDGE_REQUEST_TIMEOUT_MS } from "./request-timeout";
import { queryTabs, sendTabMessage } from "./webextension";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser extension operation deadlines", () => {
  it("rejects a content-script message when its callback never runs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      runtime: {},
      tabs: {
        sendMessage: vi.fn(() => undefined),
      },
    });

    const request = sendTabMessage(42, {
      type: "browser-bridge:capture-page",
    });
    const rejection = expect(request).rejects.toThrow(
      `tabs.sendMessage timed out after ${BROWSER_BRIDGE_REQUEST_TIMEOUT_MS} ms`,
    );

    await vi.advanceTimersByTimeAsync(BROWSER_BRIDGE_REQUEST_TIMEOUT_MS);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a browser API promise that never settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      runtime: {},
      tabs: {
        query: vi.fn(() => new Promise<never>(() => undefined)),
      },
    });

    const request = queryTabs({});
    const rejection = expect(request).rejects.toThrow(
      `tabs.query timed out after ${BROWSER_BRIDGE_REQUEST_TIMEOUT_MS} ms`,
    );

    await vi.advanceTimersByTimeAsync(BROWSER_BRIDGE_REQUEST_TIMEOUT_MS);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a callback-style operation succeeds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      runtime: {},
      tabs: {
        query: vi.fn(
          (
            _query: Record<string, unknown>,
            callback: (tabs: unknown[]) => void,
          ) => callback([{ id: 7 }]),
        ),
      },
    });

    await expect(queryTabs({})).resolves.toEqual([{ id: 7 }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
