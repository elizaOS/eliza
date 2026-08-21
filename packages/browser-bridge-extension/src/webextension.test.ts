/**
 * Adversarial tests for the browser API facade using callback- and
 * promise-style shims that never settle, matching extension-runtime hangs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_BRIDGE_REQUEST_TIMEOUT_MS } from "./request-timeout";
import {
  getManifestVersion,
  queryTabs,
  sendNativeMessage,
  sendTabMessage,
} from "./webextension";

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

  it("uses the typed native-messaging wrapper and surfaces runtime errors", async () => {
    const sendNative = vi.fn(
      (host: string, request: unknown, callback: (response: unknown) => void) =>
        callback({ host, request }),
    );
    vi.stubGlobal("chrome", {
      runtime: { sendNativeMessage: sendNative },
    });
    await expect(
      sendNativeMessage<{ v: 1 }, { host: string; request: { v: 1 } }>(
        "ai.elizaos.browserbridge",
        { v: 1 },
      ),
    ).resolves.toEqual({
      host: "ai.elizaos.browserbridge",
      request: { v: 1 },
    });
    expect(sendNative).toHaveBeenCalledTimes(1);

    vi.stubGlobal("chrome", { runtime: {} });
    await expect(
      sendNativeMessage("ai.elizaos.browserbridge", { v: 1 }),
    ).rejects.toThrow("runtime.sendNativeMessage is unavailable");
  });

  it("uses release semver instead of the Chrome four-part manifest version", () => {
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({
          version: "2.0.3.40007",
          version_name: "2.0.3-beta.7",
        }),
      },
    });
    expect(getManifestVersion()).toBe("2.0.3-beta.7");

    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "2.0.3", version_name: "invalid" }),
      },
    });
    expect(getManifestVersion()).toBe("2.0.3");

    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ version: "2.0.3.40007" }) },
    });
    expect(getManifestVersion()).toBe("0.0.0");
  });
});
