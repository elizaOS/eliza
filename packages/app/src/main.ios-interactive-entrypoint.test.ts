/**
 * Boots the renderer through the ordinary interactive iOS path, then drives
 * the native lifecycle callbacks and Cloud autologin smoke that the composition
 * root owns: keyboard, runtime-mode changes, and representative OS deep links.
 */
import { Capacitor } from "@capacitor/core";
import { runIosFullBunSmokeIfRequested } from "@elizaos/app-core";
import { client } from "@elizaos/ui/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLOUD_SMOKE_REQUEST_KEY = "eliza:ios-cloud-onboarding-smoke:request";
const CLOUD_SMOKE_RESULT_KEY = "eliza:ios-cloud-onboarding-smoke:result";
const CLOUD_SMOKE_RUN_ID = "00000000-0000-4000-8000-000000000123";
const SHARED_AGENT_BASE =
  "https://api-staging.elizacloud.ai/api/v1/eliza/agents/agent-123";

const iosBoot = vi.hoisted(() => ({
  initializeStorage: vi.fn(async () => undefined),
  initializeCapacitor: vi.fn(),
  installNativeRequest: vi.fn(),
  installFetch: vi.fn(),
  render: vi.fn(),
  createRoot: vi.fn(),
  runEmbedHandshake: vi.fn(async () => undefined),
  registerServiceWorker: vi.fn(),
  keyboardListeners: new Map<string, (value?: unknown) => void>(),
  lifecycleDependencies: undefined as
    | { handleDeepLink: (url: string) => void }
    | undefined,
  initializeAppLifecycle: vi.fn(),
  initializeNetworkListener: vi.fn(async () => undefined),
  preferenceSet: vi.fn<
    (entry: { key: string; value: string }) => Promise<void>
  >(async () => undefined),
  preferenceRemove: vi.fn(async () => undefined),
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
    remove: iosBoot.preferenceRemove,
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
    addListener: vi.fn((name: string, listener: (value?: unknown) => void) => {
      iosBoot.keyboardListeners.set(name, listener);
      return Promise.resolve({ remove: vi.fn(async () => undefined) });
    }),
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
        initializeAppLifecycle: iosBoot.initializeAppLifecycle,
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
vi.mock("./embed-bootstrap", () => ({
  runEmbedHandshake: iosBoot.runEmbedHandshake,
}));
vi.mock("./sw-registration", () => ({
  registerViewServiceWorker: iosBoot.registerServiceWorker,
}));

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Expected test fixture element: ${selector}`);
  return element;
}

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
  window.localStorage.setItem("eliza:mobile-runtime-mode", "cloud");
  window.localStorage.setItem("eliza:first-run-complete", "1");
  window.localStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: SHARED_AGENT_BASE,
    }),
  );
  iosBoot.initializeStorage.mockImplementation(async () => {
    window.localStorage.setItem("eliza:first-run-complete", "1");
    window.localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:agent-123",
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: SHARED_AGENT_BASE,
      }),
    );
  });
  window.localStorage.setItem(
    CLOUD_SMOKE_REQUEST_KEY,
    JSON.stringify({
      mode: "autologin",
      runId: CLOUD_SMOKE_RUN_ID,
      liveness: false,
      completePermissionPriming: false,
    }),
  );
  Object.assign(globalThis, {
    __ELIZAOS_UI_APP_STORE__: {
      value: {
        agentStatus: { state: "running" },
        connected: true,
        firstRunComplete: true,
        firstRunLoading: false,
        startupCoordinator: { phase: "ready", target: "cloud-managed" },
        startupError: null,
        tab: "chat",
      },
    },
  });
  document.body.innerHTML = `
    <div id="root">
      <div data-testid="home-launcher-surface" data-page="home">
        <div data-testid="home-screen">
          <div data-testid="home-time-widget"><span>10:20</span></div>
          <div data-testid="home-weather" data-status="unavailable">Weather unavailable</div>
          <div data-testid="notifications-empty">No notifications</div>
        </div>
      </div>
      <textarea data-testid="chat-composer-textarea"></textarea>
      <div data-testid="chat-sheet" data-detent="collapsed" data-maximized="false"></div>
    </div>`;

  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 844,
  });
  for (const selector of [
    '[data-testid="home-launcher-surface"]',
    '[data-testid="chat-composer-textarea"]',
  ]) {
    const element = requiredElement<HTMLElement>(selector);
    Object.defineProperty(element, "offsetParent", {
      configurable: true,
      get: () => document.body,
    });
  }
  vi.spyOn(
    requiredElement<HTMLElement>('[data-testid="home-launcher-surface"]'),
    "getBoundingClientRect",
  ).mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 390, height: 700 }));
  vi.spyOn(
    requiredElement<HTMLElement>('[data-testid="home-time-widget"] span'),
    "getBoundingClientRect",
  ).mockReturnValue(DOMRect.fromRect({ x: 20, y: 40, width: 100, height: 24 }));
  vi.spyOn(
    requiredElement<HTMLElement>('[data-testid="home-weather"]'),
    "getBoundingClientRect",
  ).mockReturnValue(DOMRect.fromRect({ x: 20, y: 80, width: 180, height: 24 }));
  vi.spyOn(client, "rawRequest").mockResolvedValue(
    new Response(JSON.stringify({ notifications: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__ELIZAOS_UI_APP_STORE__");
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("renderer interactive iOS composition", () => {
  it("mounts and routes native callbacks through the shipped handlers", async () => {
    const main = await import("./main");
    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    await vi.waitFor(() => expect(iosBoot.render).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(iosBoot.initializeAppLifecycle).toHaveBeenCalledOnce(),
    );

    expect(main.isIOS).toBe(true);
    expect(main.isNative).toBe(true);
    expect(iosBoot.installNativeRequest).toHaveBeenCalledTimes(2);
    expect(iosBoot.installFetch).toHaveBeenCalledTimes(2);

    iosBoot.keyboardListeners.get("keyboardWillShow")?.({
      keyboardHeight: 321,
    });
    expect(document.body.style.getPropertyValue("--keyboard-height")).toBe(
      "321px",
    );
    iosBoot.keyboardListeners.get("keyboardWillHide")?.();
    expect(document.body.classList).not.toContain("keyboard-open");

    document.dispatchEvent(new Event("eliza:mobile-runtime-mode-changed"));

    const handleDeepLink = iosBoot.lifecycleDependencies?.handleDeepLink;
    expect(handleDeepLink).toBeTypeOf("function");
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

    await vi.waitFor(
      () => {
        const completed = iosBoot.preferenceSet.mock.calls
          .map(([entry]) => entry)
          .find(
            (entry) =>
              entry.key === CLOUD_SMOKE_RESULT_KEY &&
              typeof entry.value === "string" &&
              JSON.parse(entry.value).phase === "complete",
          );
        expect(completed).toBeTruthy();
      },
      { timeout: 15_000 },
    );
    const cloudResult = iosBoot.preferenceSet.mock.calls
      .map(([entry]) => entry)
      .find(
        (entry) =>
          entry.key === CLOUD_SMOKE_RESULT_KEY &&
          typeof entry.value === "string" &&
          JSON.parse(entry.value).phase === "complete",
      );
    expect(JSON.parse(cloudResult?.value ?? "{}")).toMatchObject({
      ok: true,
      phase: "complete",
      mode: "autologin",
      runId: CLOUD_SMOKE_RUN_ID,
      firstRunPostCount: 0,
      firstRunPostExpectedCount: 0,
      cloudActiveServer: true,
      livenessRequested: false,
      visual: { ready: true },
    });
    expect(client.rawRequest).toHaveBeenCalledWith(
      "/api/notifications?limit=1",
      { method: "GET" },
      { allowNonOk: true, timeoutMs: 10_000 },
    );
    expect(iosBoot.preferenceRemove).toHaveBeenCalledWith({
      key: CLOUD_SMOKE_REQUEST_KEY,
    });
    const firstCloudResultWrite = iosBoot.preferenceSet.mock.calls.findIndex(
      ([entry]) => entry.key === CLOUD_SMOKE_RESULT_KEY,
    );
    expect(firstCloudResultWrite).toBeGreaterThanOrEqual(0);
    expect(iosBoot.preferenceRemove.mock.invocationCallOrder[0]).toBeLessThan(
      iosBoot.preferenceSet.mock.invocationCallOrder[firstCloudResultWrite],
    );
    expect(window.localStorage.getItem(CLOUD_SMOKE_REQUEST_KEY)).toBeNull();

    expect(window.location.hash).toContain("aec-loop");
    expect(window.__ELIZA_APP_SHARE_QUEUE__).toEqual([
      expect.objectContaining({
        source: "deep-link",
        title: "Hello",
        files: [{ name: "note.txt", path: "/tmp/note.txt" }],
      }),
    ]);
  });
});
