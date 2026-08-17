/**
 * Boots the renderer through the ordinary interactive iOS path, then drives
 * the native lifecycle callbacks that the composition root owns: runtime-mode
 * changes and representative OS deep links. Keyboard behavior is delegated to
 * and covered by the mobile-lifecycle contract suite.
 */
import { Capacitor } from "@capacitor/core";
import { runIosFullBunSmokeIfRequested } from "@elizaos/app-core/desktop-shell";
import { listenForConnectRequests } from "@elizaos/ui/events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const iosBoot = vi.hoisted(() => ({
  initializeStorage: vi.fn(async () => undefined),
  initializeCapacitor: vi.fn(),
  installNativeRequest: vi.fn(),
  installFetch: vi.fn(),
  render: vi.fn(),
  createRoot: vi.fn(),
  runEmbedHandshake: vi.fn(async () => undefined),
  registerServiceWorker: vi.fn(),
  lifecycleDependencies: undefined as
    | { handleDeepLink: (url: string) => void }
    | undefined,
  initializeDeepLinks: vi.fn(),
  initializeAppLifecycle: vi.fn(),
  initializeKeyboard: vi.fn(async () => undefined),
  initializeNetworkListener: vi.fn(async () => undefined),
  preferenceSet: vi.fn(async () => undefined),
}));

iosBoot.createRoot.mockReturnValue({ render: iosBoot.render });

vi.mock("react-dom/client", () => ({
  default: { createRoot: iosBoot.createRoot },
  createRoot: iosBoot.createRoot,
}));
vi.mock("@elizaos/ui/App", () => ({ App: () => null }));
vi.mock("@elizaos/ui/bridge/storage-bridge", () => ({
  initializeStorageBridge: iosBoot.initializeStorage,
  setStorageValue: vi.fn(async () => undefined),
}));
vi.mock("@elizaos/ui/bridge/capacitor-bridge", () => ({
  initializeCapacitorBridge: iosBoot.initializeCapacitor,
}));
vi.mock("@elizaos/app-core/api/ios-local-agent-transport", () => ({
  installIosLocalAgentNativeRequestBridge: iosBoot.installNativeRequest,
  installIosLocalAgentFetchBridge: iosBoot.installFetch,
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: iosBoot.preferenceSet,
    remove: vi.fn(async () => undefined),
  },
}));
vi.mock("@capacitor/background-runner", () => ({
  BackgroundRunner: { dispatchEvent: vi.fn(async () => undefined) },
}));
vi.mock("@capacitor/keyboard", () => ({
  KeyboardResize: { None: "none" },
  Keyboard: {
    setResizeMode: vi.fn(async () => undefined),
    setScroll: vi.fn(async () => undefined),
    setAccessoryBarVisible: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
}));
vi.mock("@capacitor/status-bar", () => ({
  Style: { Dark: "dark" },
  StatusBar: {
    setStyle: vi.fn(async () => undefined),
    setOverlaysWebView: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(async () => undefined),
  },
}));
vi.mock("@elizaos/capacitor-agent", () => ({
  Agent: { getStatus: vi.fn(async () => ({ ready: true })) },
}));
vi.mock("./mobile-lifecycle", () => ({
  createMobileLifecycle: vi.fn(
    (dependencies: { handleDeepLink: (url: string) => void }) => {
      iosBoot.lifecycleDependencies = dependencies;
      return {
        initializeDeepLinks: iosBoot.initializeDeepLinks,
        initializeAppLifecycle: iosBoot.initializeAppLifecycle,
        initializeKeyboard: iosBoot.initializeKeyboard,
        initializeNetworkListener: iosBoot.initializeNetworkListener,
      };
    },
  ),
}));
vi.mock("./boot-voice-load", () => ({
  startVoiceModuleLoad: vi.fn(() =>
    Promise.resolve({
      installAecLoopHarness: vi.fn(),
      registerDesktopFusedWake: vi.fn(),
    }),
  ),
}));
vi.mock("./ios-attachment-smoke", () => ({
  runIosAttachmentSmokeIfRequested: vi.fn(async () => false),
}));
vi.mock("./ios-voice-selftest-smoke", () => ({
  runIosVoiceSelfTestSmokeIfRequested: vi.fn(async () => false),
}));
vi.mock("./keyboard-dictation", () => ({
  startKeyboardDictationSession: vi.fn(),
}));
vi.mock("./embed-bootstrap", async (importOriginal) => ({
  // Keep the real isEmbedPath (pure route predicate consumed by the renderer
  // shell-scope resolution); only the network-touching handshake is stubbed.
  ...(await importOriginal<typeof import("./embed-bootstrap")>()),
  runEmbedHandshake: iosBoot.runEmbedHandshake,
}));
vi.mock("./sw-registration", () => ({
  registerViewServiceWorker: iosBoot.registerServiceWorker,
}));

beforeEach(() => {
  vi.mocked(Capacitor.getPlatform).mockReturnValue("ios");
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(runIosFullBunSmokeIfRequested).mockResolvedValue(false);
  vi.stubGlobal("__ELIZA_BUILD_VARIANT__", "local");
  vi.stubGlobal("__ELIZA_WEB_SHELL__", false);
  vi.stubGlobal("__ELIZA_CHAT_UI_HARNESS__", false);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  window.localStorage.setItem("eliza:mobile-runtime-mode", "local");
  document.body.innerHTML = '<div id="root"></div>';
});

describe("renderer interactive iOS composition", () => {
  it("mounts and routes native callbacks through the shipped handlers", async () => {
    const main = await import("./main");
    expect(iosBoot.initializeDeepLinks).toHaveBeenCalledOnce();
    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    await vi.waitFor(() => expect(iosBoot.render).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(iosBoot.initializeAppLifecycle).toHaveBeenCalledOnce(),
    );
    expect(iosBoot.initializeKeyboard).toHaveBeenCalledOnce();

    expect(main.isIOS).toBe(true);
    expect(main.isNative).toBe(true);
    expect(iosBoot.installNativeRequest).toHaveBeenCalledTimes(2);
    expect(iosBoot.installFetch).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new Event("eliza:mobile-runtime-mode-changed"));

    const handleDeepLink = iosBoot.lifecycleDependencies?.handleDeepLink;
    expect(handleDeepLink).toBeTypeOf("function");
    const connectRequest = vi.fn();
    const removeConnectListener = listenForConnectRequests(connectRequest);
    window.localStorage.setItem(
      "eliza:auth-callback-smoke:request",
      JSON.stringify({ state: "smoke", code: "synthetic" }),
    );
    for (const url of [
      "not a url",
      "elizaos://settings",
      "elizaos://phone/call?contact=alice",
      "elizaos://messages/compose?to=bob",
      "elizaos://contacts",
      "elizaos://aec-loop?duration=1",
      "elizaos://keyboard-dictation",
      "elizaos://connect?url=http%3A%2F%2Flocalhost%3A2138",
      "elizaos://first-run/runtime/remote?api=http%3A%2F%2F127.0.0.1%3A31337",
      "elizaos://share?title=Hello&text=Body&file=%2Ftmp%2Fnote.txt",
      "elizaos://auth/callback?state=smoke&code=synthetic",
      "elizaos://unknown-path",
    ]) {
      handleDeepLink?.(url);
    }

    await vi.waitFor(() =>
      expect(iosBoot.preferenceSet).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "eliza:auth-callback-smoke:result",
          value: expect.stringContaining('"phase":"handled"'),
        }),
      ),
    );

    expect(window.location.hash).toContain("aec-loop");
    expect(connectRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "http://127.0.0.1:31337",
        completeFirstRun: true,
      }),
    );
    removeConnectListener();
    expect(window.__ELIZA_APP_SHARE_QUEUE__).toEqual([
      expect.objectContaining({
        source: "deep-link",
        title: "Hello",
        files: [{ name: "note.txt", path: "/tmp/note.txt" }],
      }),
    ]);
  });
});
