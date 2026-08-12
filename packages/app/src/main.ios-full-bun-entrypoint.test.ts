/**
 * Imports the real renderer composition root as an iOS WebView and proves the
 * headless full-Bun gate takes ownership before interactive route boot. Native
 * process boundaries are substituted by the shared jsdom bridge mocks.
 */
import { Capacitor } from "@capacitor/core";
import { runIosFullBunSmokeIfRequested } from "@elizaos/app-core/desktop-shell";
import { beforeEach, describe, expect, it, vi } from "vitest";

const entrypoint = vi.hoisted(() => ({
  initializeStorage: vi.fn(async () => undefined),
  initializeCapacitor: vi.fn(),
  installNativeRequest: vi.fn(),
  installFetch: vi.fn(),
  runEmbedHandshake: vi.fn(async () => undefined),
  registerServiceWorker: vi.fn(),
}));

vi.mock("@elizaos/ui/bridge/storage-bridge", () => ({
  initializeStorageBridge: entrypoint.initializeStorage,
  setStorageValue: vi.fn(async () => undefined),
}));
vi.mock("@elizaos/ui/bridge/capacitor-bridge", () => ({
  initializeCapacitorBridge: entrypoint.initializeCapacitor,
}));
vi.mock("@elizaos/app-core/api/ios-local-agent-transport", () => ({
  installIosLocalAgentNativeRequestBridge: entrypoint.installNativeRequest,
  installIosLocalAgentFetchBridge: entrypoint.installFetch,
}));
vi.mock("./embed-bootstrap", async (importOriginal) => ({
  // Keep the real isEmbedPath (pure route predicate consumed by the renderer
  // shell-scope resolution); only the network-touching handshake is stubbed.
  ...(await importOriginal<typeof import("./embed-bootstrap")>()),
  runEmbedHandshake: entrypoint.runEmbedHandshake,
}));
vi.mock("./sw-registration", () => ({
  registerViewServiceWorker: entrypoint.registerServiceWorker,
}));

beforeEach(() => {
  vi.mocked(Capacitor.getPlatform).mockReturnValue("ios");
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(runIosFullBunSmokeIfRequested).mockResolvedValue(true);
  vi.stubGlobal("__ELIZA_BUILD_VARIANT__", "local");
  vi.stubGlobal("__ELIZA_WEB_SHELL__", false);
  vi.stubGlobal("__ELIZA_CHAT_UI_HARNESS__", false);
});

describe("renderer iOS full-Bun composition", () => {
  it("short-circuits normal boot after installing the native agent bridges", async () => {
    const main = await import("./main");
    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    await vi.waitFor(() => {
      expect(runIosFullBunSmokeIfRequested).toHaveBeenCalledOnce();
    });

    expect(main.isIOS).toBe(true);
    expect(main.isNative).toBe(true);
    expect(entrypoint.runEmbedHandshake).toHaveBeenCalledOnce();
    expect(entrypoint.initializeStorage).toHaveBeenCalledOnce();
    expect(entrypoint.initializeCapacitor).toHaveBeenCalledOnce();
    expect(entrypoint.installNativeRequest).toHaveBeenCalledOnce();
    expect(entrypoint.installFetch).toHaveBeenCalledOnce();
  });
});
