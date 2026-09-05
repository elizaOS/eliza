/**
 * @vitest-environment jsdom
 *
 * Proves the renderer registration entry through the REAL renderer-service
 * registry (`@elizaos/ui/platform/renderer-services` is anchored to source in
 * this package's vitest config — no mocked lifecycle) driving the REAL capture
 * controller: importing `register.ts` registers a main-scoped service without
 * starting any work, a popout/detached host never starts the capture, a main
 * host starts it, and disposing the host stops it (listeners removed, restart
 * possible). Only the HTTP client and native bridges are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // The client-lifeops / client-calendar extension modules (side-effect
  // imports of the capture) install methods onto ElizaClient.prototype at
  // module scope; give the mock a real class so those installs land.
  ElizaClient: class ElizaClient {},
  getStatus: vi.fn(async () => ({ state: "running" })),
  captureLifeOpsActivitySignal: vi.fn(async () => ({
    signal: { id: "sig-1" },
  })),
  isApiError: vi.fn((_error: unknown) => false),
  isAuthenticatedNow: vi.fn(() => true),
  getAuthStatusSnapshot: vi.fn(() => ({
    phase: "authenticated",
    identity: { id: "test-user" },
    session: { id: "test-session" },
    access: { role: "OWNER" },
  })),
  subscribeAuthStatus: vi.fn(() => () => undefined),
  isElectrobunRuntime: vi.fn(() => false),
  loadDesktopWorkspaceSnapshot: vi.fn(async () => ({ supported: false })),
  capacitorGetPlatform: vi.fn(() => "web"),
  capacitorIsPluginAvailable: vi.fn(() => true),
  capacitorIsNative: vi.fn(() => false),
  mobile: {
    checkPermissions: vi.fn(async () => ({ status: "granted" })),
    addListener: vi.fn(
      async (_event: string, _cb: (signal: unknown) => void) => ({
        remove: vi.fn(async () => {}),
      }),
    ),
    startMonitoring: vi.fn(async () => ({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    })),
    stopMonitoring: vi.fn(async () => ({ stopped: true })),
    getSnapshot: vi.fn(async () => ({
      supported: false,
      snapshot: null,
      healthSnapshot: null,
    })),
    scheduleBackgroundRefresh: vi.fn(async () => ({ scheduled: false })),
    cancelBackgroundRefresh: vi.fn(async () => ({ cancelled: true })),
  },
}));

// The four @elizaos/ui subpath specifiers (/api, /bridge, /browser, /events)
// alias to one stub file under this package's vitest config, so each mock
// carries the full export surface the capture module reads — the last mock
// registered for the shared file wins.
vi.mock("@elizaos/ui/api", () => ({
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  isElectrobunRuntime: h.isElectrobunRuntime,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));
vi.mock("@elizaos/ui/bridge", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
}));
vi.mock("@elizaos/ui/events", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
}));
vi.mock("@elizaos/ui/browser", () => ({
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));

vi.mock("@elizaos/ui/auth-status", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  ElizaClient: h.ElizaClient,
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  getAuthStatusSnapshot: h.getAuthStatusSnapshot,
  isElectrobunRuntime: h.isElectrobunRuntime,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  subscribeAuthStatus: h.subscribeAuthStatus,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: h.capacitorGetPlatform,
    isPluginAvailable: h.capacitorIsPluginAvailable,
    isNativePlatform: h.capacitorIsNative,
  },
}));

// Web-platform tests never touch MobileSignals beyond this stub; the
// inter-instance and abort-propagation tests below switch the platform to
// native and drive `h.mobile` directly.
vi.mock("@elizaos/capacitor-mobile-signals", () => ({
  MobileSignals: h.mobile,
}));

// Spy on (never replace) the real capture entry point so one test can assert
// on the arguments register.ts's own `start` callback passes it, without
// losing real behavior for every other test in this file.
vi.mock("./lifeops/activity-signals-capture.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./lifeops/activity-signals-capture.js")
    >();
  return {
    ...actual,
    startLifeOpsActivitySignalCapture: vi.fn(
      actual.startLifeOpsActivitySignalCapture,
    ),
  };
});

import {
  getRendererServiceStates,
  registerRendererService,
  settleRendererServices,
  startRendererServiceHost,
} from "@elizaos/ui/platform/renderer-services";
import {
  isLifeOpsActivitySignalCaptureActive,
  startLifeOpsActivitySignalCapture,
} from "./lifeops/activity-signals-capture.js";
// Side-effect import under test: registers the renderer service definition.
import "./register.js";

const spiedStartCapture = vi.mocked(startLifeOpsActivitySignalCapture);

const SERVICE_ID = "personal-assistant.lifeops-activity-signals";

function serviceState() {
  return getRendererServiceStates().services.find((s) => s.id === SERVICE_ID);
}

async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("personal-assistant renderer registration entry", () => {
  let host: { dispose: () => void } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    h.getStatus.mockResolvedValue({ state: "running" });
    h.capacitorGetPlatform.mockReturnValue("web");
    h.capacitorIsPluginAvailable.mockReturnValue(true);
    h.capacitorIsNative.mockReturnValue(false);
    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });
    h.mobile.addListener.mockImplementation(
      async (_event: string, _cb: (signal: unknown) => void) => ({
        remove: vi.fn(async () => {}),
      }),
    );
    // vi.clearAllMocks() clears calls but not implementations, so a test
    // that pauses a native call must not leak its unreleased promise into
    // the next test.
    h.mobile.stopMonitoring.mockImplementation(async () => ({
      stopped: true,
    }));
    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    h.mobile.getSnapshot.mockResolvedValue({
      supported: false,
      snapshot: null,
      healthSnapshot: null,
    });
    h.mobile.scheduleBackgroundRefresh.mockResolvedValue({ scheduled: false });
    h.mobile.cancelBackgroundRefresh.mockResolvedValue({ cancelled: true });
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await settle();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
  });

  it("registers the main-scoped service at import time without starting capture", () => {
    const state = serviceState();
    expect(state).toBeDefined();
    expect(state?.shells).toEqual(["main"]);
    // No host installed in this environment yet: nothing may have started.
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("never starts the capture in popout or detached window shells", async () => {
    host = startRendererServiceHost({ shell: "popout" });
    await settleRendererServices();
    expect(serviceState()?.status).toBe("ineligible");
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(h.getStatus).not.toHaveBeenCalled();
    host.dispose();

    host = startRendererServiceHost({ shell: "detached" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("starts the capture under a main-shell host and stops it on dispose", async () => {
    const removeDoc = vi.spyOn(document, "removeEventListener");

    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(serviceState()?.status).toBe("running");
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    await settle();
    // The real capture probed the runtime and posted presence.
    expect(h.getStatus).toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();

    host.dispose();
    host = undefined;
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(removeDoc).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    removeDoc.mockRestore();
  });

  it("re-initializes on host replacement (old capture stopped, new one running)", async () => {
    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    const firstProbeCount = h.getStatus.mock.calls.length;

    // A replacement host (repeated boot / shell HMR) must stop the old
    // instance and start a fresh one — not stack a second capture.
    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    expect(serviceState()?.status).toBe("running");
    await settle();
    expect(h.getStatus.mock.calls.length).toBeGreaterThan(firstProbeCount);
  });

  it("tears down on pagehide (page teardown)", async () => {
    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);

    window.dispatchEvent(new Event("pagehide"));
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    host = undefined;
  });

  it("serializes host replacement so a slow old-generation stopMonitoring cannot land after the new generation's startMonitoring (#17110)", async () => {
    h.capacitorIsNative.mockReturnValue(true);
    h.capacitorGetPlatform.mockReturnValue("ios");

    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    for (let i = 0; i < 8; i += 1) {
      await settle();
    }
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    let releaseStopMonitoring: (() => void) | undefined;
    h.mobile.stopMonitoring.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStopMonitoring = () => resolve({ stopped: true });
        }),
    );

    // Host replacement (shell HMR / repeated boot) while the old
    // generation's native stopMonitoring call is still in flight.
    host = startRendererServiceHost({ shell: "main" });

    // Give the replacement generation ample opportunity to race ahead if it
    // is not actually serialized behind the old generation's teardown.
    for (let i = 0; i < 12; i += 1) {
      await settle();
    }
    // The replacement is serialized behind the old generation's still-
    // pending stop — its own startMonitoring must not have run yet.
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    releaseStopMonitoring?.();
    await settleRendererServices();
    for (let i = 0; i < 8; i += 1) {
      await settle();
    }

    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
  });

  it("awaits the real capture's async cleanup before a re-registered instance starts (HMR) (#17110)", async () => {
    h.capacitorIsNative.mockReturnValue(true);
    h.capacitorGetPlatform.mockReturnValue("ios");

    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    for (let i = 0; i < 8; i += 1) {
      await settle();
    }
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    let releaseStopMonitoring: (() => void) | undefined;
    h.mobile.stopMonitoring.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStopMonitoring = () => resolve({ stopped: true });
        }),
    );

    // Simulate dev HMR re-evaluating register.ts: the same id re-registers
    // with the same start wiring while the old instance's native
    // stopMonitoring call is still in flight.
    registerRendererService({
      id: SERVICE_ID,
      shells: ["main"],
      start: (context) => startLifeOpsActivitySignalCapture(true, context),
    });

    for (let i = 0; i < 12; i += 1) {
      await settle();
    }
    // The re-registered instance is serialized behind the old instance's
    // still-pending native stopMonitoring call.
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    releaseStopMonitoring?.();
    await settleRendererServices();
    for (let i = 0; i < 8; i += 1) {
      await settle();
    }
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
  });

  it("serializes host replacement behind an in-flight native startup's rollback (#17110)", async () => {
    h.capacitorIsNative.mockReturnValue(true);
    h.capacitorGetPlatform.mockReturnValue("ios");

    let releaseStartMonitoring: ((value: unknown) => void) | undefined;
    h.mobile.startMonitoring.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStartMonitoring = resolve;
        }),
    );

    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    for (let i = 0; i < 8; i += 1) {
      await settle();
    }
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    // Replace the host while the predecessor's startMonitoring is still in
    // flight — nothing is committed yet, so a stop() that only awaits
    // committed resources would resolve immediately and let the successor's
    // monitor race the predecessor's late rollback.
    host = startRendererServiceHost({ shell: "main" });
    for (let i = 0; i < 12; i += 1) {
      await settle();
    }
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    releaseStartMonitoring?.({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    await settleRendererServices();
    for (let i = 0; i < 12; i += 1) {
      await settle();
    }
    // Predecessor rollback (stopMonitoring) completed, then — and only
    // then — the successor engaged its own monitor.
    expect(h.mobile.stopMonitoring).toHaveBeenCalled();
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
  });

  it("register.ts threads the host's per-instance context (shell + abort signal) into the capture's start()", async () => {
    // Drives register.ts's REAL `start` wiring (only the capture entry point
    // is spied, not replaced), proving the registration entry itself passes
    // the context through rather than dropping it (#17110).
    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();

    expect(spiedStartCapture).toHaveBeenCalledTimes(1);
    const [enabledArg, contextArg] = spiedStartCapture.mock.calls[0] ?? [];
    expect(enabledArg).toBe(true);
    expect(contextArg?.shell).toBe("main");
    expect(contextArg?.signal).toBeInstanceOf(AbortSignal);
    expect(contextArg?.signal?.aborted).toBe(false);

    host.dispose();
    host = undefined;
    await settle();
    expect(contextArg?.signal?.aborted).toBe(true);
  });
});
