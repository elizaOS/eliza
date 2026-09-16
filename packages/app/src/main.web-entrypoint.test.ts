/**
 * Boots the real renderer composition root on the ordinary web path through
 * bridge initialization and React mounting. Only the final React renderer is
 * substituted so the test can inspect boot completion without mounting the
 * full dashboard tree.
 */
import { Capacitor } from "@capacitor/core";
import { runIosFullBunSmokeIfRequested } from "@elizaos/app-core/desktop-shell";
import { STEWARD_ACTIVE_SCOPE_KEY } from "@elizaos/shared/steward-session-client";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "@elizaos/ui/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webBoot = vi.hoisted(() => ({
  initializeStorage: vi.fn(async () => undefined),
  initializeCapacitor: vi.fn(),
  render: vi.fn(),
  createRoot: vi.fn(),
  runEmbedHandshake: vi.fn(async () => undefined),
  registerServiceWorker: vi.fn(),
  cloudApiBaseAtServiceWorkerModuleLoad: undefined as string | undefined,
}));

webBoot.createRoot.mockReturnValue({ render: webBoot.render });
const animationFrames: FrameRequestCallback[] = [];
const idleCallbacks: IdleRequestCallback[] = [];

vi.mock("react-dom/client", () => ({
  default: { createRoot: webBoot.createRoot },
  createRoot: webBoot.createRoot,
}));
vi.mock("@elizaos/ui/App", () => ({ App: () => null }));
vi.mock("@elizaos/ui/bridge/storage-bridge", () => ({
  initializeStorageBridge: webBoot.initializeStorage,
  setStorageValue: vi.fn(async () => undefined),
}));
vi.mock("@elizaos/ui/bridge/capacitor-bridge", () => ({
  initializeCapacitorBridge: webBoot.initializeCapacitor,
}));
vi.mock("@elizaos/app-core/api/ios-local-agent-transport", () => ({
  installIosLocalAgentNativeRequestBridge: vi.fn(),
  installIosLocalAgentFetchBridge: vi.fn(),
}));
vi.mock("./embed-bootstrap", async (importOriginal) => ({
  // Keep the real isEmbedPath (pure route predicate consumed by the renderer
  // shell-scope resolution); only the network-touching handshake is stubbed.
  ...(await importOriginal<typeof import("./embed-bootstrap")>()),
  runEmbedHandshake: webBoot.runEmbedHandshake,
}));
vi.mock("./sw-registration", () => {
  const bootConfig = Reflect.get(globalThis, "__ELIZAOS_APP_BOOT_CONFIG__") as
    | { cloudApiBase?: unknown }
    | undefined;
  webBoot.cloudApiBaseAtServiceWorkerModuleLoad =
    typeof bootConfig?.cloudApiBase === "string"
      ? bootConfig.cloudApiBase
      : undefined;
  return { registerViewServiceWorker: webBoot.registerServiceWorker };
});

beforeEach(() => {
  vi.mocked(Capacitor.getPlatform).mockReturnValue("web");
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  vi.mocked(runIosFullBunSmokeIfRequested).mockResolvedValue(false);
  vi.stubGlobal("__ELIZA_BUILD_VARIANT__", "local");
  vi.stubGlobal("__ELIZA_WEB_SHELL__", false);
  vi.stubGlobal("__ELIZA_SERVICE_WORKER__", true);
  vi.stubGlobal("__ELIZA_CHAT_UI_HARNESS__", false);
  vi.stubEnv("VITE_ELIZA_CLOUD_BASE", "https://cloud-staging.eliza.app");
  setBootConfig(DEFAULT_BOOT_CONFIG);
  webBoot.cloudApiBaseAtServiceWorkerModuleLoad = undefined;
  animationFrames.length = 0;
  idleCallbacks.length = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }),
  );
  vi.stubGlobal(
    "requestIdleCallback",
    vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    }),
  );
  document.body.innerHTML = '<div id="root"></div>';
  window.localStorage.clear();
});

describe("renderer web composition", () => {
  it("mounts after app config, styles, storage, and platform bridges", async () => {
    const main = await import("./main");
    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    await vi.waitFor(() => expect(webBoot.render).toHaveBeenCalledOnce());

    expect(main.platform).toBe("web");
    expect(main.isNative).toBe(false);
    expect(webBoot.runEmbedHandshake).toHaveBeenCalledOnce();
    expect(webBoot.registerServiceWorker).toHaveBeenCalledOnce();
    expect(webBoot.cloudApiBaseAtServiceWorkerModuleLoad).toBe(
      "https://cloud-staging.eliza.app",
    );
    expect(getBootConfig()).toMatchObject({
      preferSharedCloudTier: false,
      autoUpgradeSharedToDedicated: true,
    });
    expect(window.localStorage.getItem(STEWARD_ACTIVE_SCOPE_KEY)).toBe(
      "eliza-cloud:staging",
    );
    expect(webBoot.initializeStorage).toHaveBeenCalledTimes(2);
    expect(webBoot.initializeCapacitor).toHaveBeenCalledOnce();
    expect(document.body.classList).toContain("platform-web");

    // Route/app registration is deliberately queued after two paint frames,
    // then split into idle queues so it cannot compete with the visible shell.
    expect(animationFrames).toHaveLength(1);
    animationFrames.shift()?.(0);
    expect(animationFrames).toHaveLength(1);
    animationFrames.shift()?.(0);
    expect(idleCallbacks).toHaveLength(1);
  });
});
