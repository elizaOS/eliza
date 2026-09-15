/**
 * Boots the renderer through Android local mode and proves its distinct native
 * composition: foreground agent fetch, llama device bridge, voice harnesses,
 * status bar, and authenticated background-runner configuration.
 */
import { Capacitor } from "@capacitor/core";
import { runIosFullBunSmokeIfRequested } from "@elizaos/app-core/desktop-shell";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "@elizaos/ui/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const androidBoot = vi.hoisted(() => ({
  initializeStorage: vi.fn(async () => undefined),
  initializeCapacitor: vi.fn(),
  installAndroidFetch: vi.fn(),
  render: vi.fn(),
  createRoot: vi.fn(),
  dispatchBackground: vi.fn(async () => undefined),
  startDeviceBridge: vi.fn(() => ({ stop: vi.fn() })),
  setStatusStyle: vi.fn(async () => undefined),
  setStatusOverlay: vi.fn(async () => undefined),
  setStatusColor: vi.fn(async () => undefined),
  installDiarization: vi.fn(),
  installJniVoice: vi.fn(),
  installAec: vi.fn(),
  initializeDeepLinks: vi.fn(),
  initializeAppLifecycle: vi.fn(),
  initializeKeyboard: vi.fn(async () => undefined),
  initializeNetworkListener: vi.fn(async () => undefined),
  startCameraBridgeResponder: vi.fn(() => vi.fn()),
  registerWebsiteBlocker: vi.fn(),
  registerAppBlocker: vi.fn(),
}));

androidBoot.createRoot.mockReturnValue({ render: androidBoot.render });

vi.mock("react-dom/client", () => ({
  default: { createRoot: androidBoot.createRoot },
  createRoot: androidBoot.createRoot,
}));
vi.mock("@elizaos/ui/App", () => ({ App: () => null }));
vi.mock("@elizaos/ui/bridge/storage-bridge", () => ({
  initializeStorageBridge: androidBoot.initializeStorage,
  setStorageValue: vi.fn(async () => undefined),
}));
vi.mock("@elizaos/ui/bridge/capacitor-bridge", () => ({
  initializeCapacitorBridge: androidBoot.initializeCapacitor,
}));
vi.mock("@elizaos/ui/api/android-native-agent-transport", () => ({
  installAndroidNativeAgentFetchBridge: androidBoot.installAndroidFetch,
}));
vi.mock("@elizaos/app-core/api/ios-local-agent-transport", () => ({
  installIosLocalAgentNativeRequestBridge: vi.fn(),
  installIosLocalAgentFetchBridge: vi.fn(),
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: "android-device-1" })),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
}));
vi.mock("@capacitor/background-runner", () => ({
  BackgroundRunner: { dispatchEvent: androidBoot.dispatchBackground },
}));
vi.mock("@capacitor/keyboard", () => ({
  KeyboardResize: { None: "none" },
  Keyboard: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock("@capacitor/status-bar", () => ({
  Style: { Dark: "dark" },
  StatusBar: {
    setStyle: androidBoot.setStatusStyle,
    setOverlaysWebView: androidBoot.setStatusOverlay,
    setBackgroundColor: androidBoot.setStatusColor,
  },
}));
vi.mock("@elizaos/capacitor-agent", () => ({
  Agent: {
    getStatus: vi.fn(async () => ({ ready: true })),
    getLocalAgentToken: vi.fn(async () => ({ token: "android-token" })),
  },
}));
vi.mock("@elizaos/capacitor-llama", () => ({
  startDeviceBridgeClient: androidBoot.startDeviceBridge,
}));
vi.mock("./camera-bridge-responder", () => ({
  startCameraBridgeResponder: androidBoot.startCameraBridgeResponder,
}));
vi.mock("@elizaos/plugin-blocker/native", () => ({
  registerNativeWebsiteBlockerBackend: androidBoot.registerWebsiteBlocker,
  registerNativeAppBlockerBackend: androidBoot.registerAppBlocker,
}));
vi.mock("@elizaos/capacitor-websiteblocker", () => ({
  WebsiteBlocker: {},
  createNativeWebsiteBlockerBackend: vi.fn(() => ({ kind: "website" })),
}));
vi.mock("@elizaos/capacitor-appblocker", () => ({
  AppBlocker: {},
  createNativeAppBlockerBackend: vi.fn(() => ({ kind: "app" })),
}));
vi.mock("./mobile-lifecycle", () => ({
  createMobileLifecycle: vi.fn(() => ({
    initializeDeepLinks: androidBoot.initializeDeepLinks,
    initializeAppLifecycle: androidBoot.initializeAppLifecycle,
    initializeKeyboard: androidBoot.initializeKeyboard,
    initializeNetworkListener: androidBoot.initializeNetworkListener,
  })),
}));
vi.mock("./boot-voice-load", () => ({
  startVoiceModuleLoad: vi.fn(() =>
    Promise.resolve({
      installDiarizationPumpHarness: androidBoot.installDiarization,
      installJniVoiceHarness: androidBoot.installJniVoice,
      installAecLoopHarness: androidBoot.installAec,
      registerDesktopFusedWake: vi.fn(),
    }),
  ),
}));
vi.mock("./ios-attachment-smoke", () => ({
  runIosAttachmentSmokeIfRequested: vi.fn(async () => false),
}));
vi.mock("./embed-bootstrap", async (importOriginal) => ({
  // Keep the real isEmbedPath (pure route predicate consumed by the renderer
  // shell-scope resolution); only the network-touching handshake is stubbed.
  ...(await importOriginal<typeof import("./embed-bootstrap")>()),
  runEmbedHandshake: vi.fn(async () => undefined),
}));
vi.mock("./sw-registration", () => ({
  registerViewServiceWorker: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(Capacitor.getPlatform).mockReturnValue("android");
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(runIosFullBunSmokeIfRequested).mockResolvedValue(false);
  vi.stubGlobal("__ELIZA_BUILD_VARIANT__", "local");
  vi.stubGlobal("__ELIZA_WEB_SHELL__", false);
  vi.stubGlobal("__ELIZA_SERVICE_WORKER__", false);
  vi.stubGlobal("__ELIZA_CHAT_UI_HARNESS__", false);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  setBootConfig(DEFAULT_BOOT_CONFIG);
  window.localStorage.setItem("eliza:mobile-runtime-mode", "local");
  document.body.innerHTML = '<div id="root"></div>';
});

describe("renderer Android local composition", () => {
  it("connects the native agent and device bridges after mounting", async () => {
    const main = await import("./main");
    expect(androidBoot.initializeDeepLinks).toHaveBeenCalledOnce();
    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    await vi.waitFor(() => expect(androidBoot.render).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(androidBoot.startDeviceBridge).toHaveBeenCalledOnce(),
    );
    expect(androidBoot.initializeKeyboard).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(androidBoot.startCameraBridgeResponder).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(androidBoot.registerWebsiteBlocker).toHaveBeenCalledOnce(),
    );

    expect(main.isAndroid).toBe(true);
    expect(main.isNative).toBe(true);
    expect(getBootConfig()).toMatchObject({
      preferSharedCloudTier: false,
      autoUpgradeSharedToDedicated: true,
    });
    expect(androidBoot.installAndroidFetch).toHaveBeenCalledOnce();
    expect(androidBoot.installDiarization).toHaveBeenCalledOnce();
    expect(androidBoot.installJniVoice).toHaveBeenCalledOnce();
    expect(androidBoot.installAec).toHaveBeenCalledOnce();
    expect(androidBoot.setStatusStyle).toHaveBeenCalledOnce();
    expect(androidBoot.setStatusOverlay).toHaveBeenCalledWith({
      overlay: true,
    });
    expect(androidBoot.setStatusColor).toHaveBeenCalledWith({
      color: "#00000000",
    });
    expect(androidBoot.startDeviceBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        pairingToken: "android-token",
        deviceId: "android-device-1",
      }),
    );
    expect(androidBoot.dispatchBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "configure",
        details: expect.objectContaining({ authToken: "android-token" }),
      }),
    );
  });
});
