/**
 * @vitest-environment jsdom
 *
 * Drives the imperative activity-signal capture controller against a mocked
 * ElizaClient + native bridges in a real jsdom browser environment across all
 * three device shapes (web, desktop/Electrobun, native mobile). Proves it
 * posts presence once the runtime reports running, re-emits on
 * lifecycle/visibility events, dedupes rapid repeats, maps native mobile
 * snapshots, degrades quietly on runtime-unavailable/network/signed-out
 * (401)/agent-gone (structural 404) errors, surfaces
 * unexpected failures observably, is idempotent across repeated starts,
 * enforces the permission consent gate, survives stop() racing any awaited
 * native operation without leaking handles/monitors/intervals, and fully
 * tears down its listeners/intervals on stop.
 *
 * `@elizaos/ui/api`, `/auth-status`, `/bridge`, `/browser`, and `/events` all
 * alias to the same stub file under this package's vitest config, so a single
 * complete mock factory is shared across the specifiers — otherwise the last
 * `vi.mock` wins and drops exports the earlier specifiers need.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const mobile = {
    listenerCb: null as null | ((signal: unknown) => void),
    checkPermissions: vi.fn(async () => ({ status: "granted" })),
    addListener: vi.fn(
      async (_event: string, cb: (signal: unknown) => void) => {
        mobile.listenerCb = cb;
        return { remove: vi.fn(async () => {}) };
      },
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
    scheduleBackgroundRefresh: vi.fn(async () => ({ scheduled: true })),
    cancelBackgroundRefresh: vi.fn(async () => ({ cancelled: true })),
  };
  return {
    // The client-lifeops / client-calendar extension modules (side-effect
    // imports of the capture) install methods onto ElizaClient.prototype at
    // module scope; give the mock a real class so those installs land.
    ElizaClient: class ElizaClient {},
    getStatus: vi.fn(async () => ({ state: "running" })),
    captureLifeOpsActivitySignal: vi.fn(async () => ({
      signal: { id: "sig-1" },
    })),
    isApiError: vi.fn((_error: unknown) => false),
    isCloudAgentGoneError: vi.fn((error: unknown) => {
      let current: unknown = error;
      for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
        const { status, code } = current as Error & {
          status?: unknown;
          code?: unknown;
        };
        if (
          status === 404 &&
          (code === "agent_not_found" ||
            current.message.includes("agent not found or not running"))
        ) {
          return true;
        }
        current = (current as Error & { cause?: unknown }).cause;
      }
      return false;
    }),
    isElectrobunRuntime: vi.fn(() => false),
    loadDesktopWorkspaceSnapshot: vi.fn(async () => ({ supported: false })),
    authState: { phase: "authenticated" } as { phase: string },
    authSubscribers: new Set<(state: { phase: string }) => void>(),
    dispatchStatus: vi.fn(),
    capacitorGetPlatform: vi.fn(() => "web"),
    capacitorIsNative: vi.fn(() => false),
    mobile,
  };
});

// The @elizaos/ui subpath specifiers (/api, /auth-status, /bridge, /browser,
// /events)
// all alias to the same stub file under this package's vitest config, so each
// mock returns the same combined shape: client + error classifiers + ElizaClient
// (/api), isElectrobunRuntime (/bridge), loadDesktopWorkspaceSnapshot
// (/browser), lifecycle event names (/events). The object literal is inlined
// per call and reads only the hoisted `h` — any module-scope const would sit
// in its TDZ when the hoisted `vi.mock` and source import run.
vi.mock("@elizaos/ui/api", () => ({
  isApiError: h.isApiError,
  isCloudAgentGoneError: h.isCloudAgentGoneError,
  ElizaClient: h.ElizaClient,
  isElectrobunRuntime: h.isElectrobunRuntime,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  isAuthenticatedNow: () => h.authState.phase === "authenticated",
  subscribeAuthStatus: (listener: (state: { phase: string }) => void) => {
    h.authSubscribers.add(listener);
    return () => h.authSubscribers.delete(listener);
  },
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
  isCloudAgentGoneError: h.isCloudAgentGoneError,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  isAuthenticatedNow: () => h.authState.phase === "authenticated",
  subscribeAuthStatus: (listener: (state: { phase: string }) => void) => {
    h.authSubscribers.add(listener);
    return () => h.authSubscribers.delete(listener);
  },
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
  isCloudAgentGoneError: h.isCloudAgentGoneError,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  isAuthenticatedNow: () => h.authState.phase === "authenticated",
  subscribeAuthStatus: (listener: (state: { phase: string }) => void) => {
    h.authSubscribers.add(listener);
    return () => h.authSubscribers.delete(listener);
  },
}));
vi.mock("@elizaos/ui/browser", () => ({
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  isCloudAgentGoneError: h.isCloudAgentGoneError,
  ElizaClient: h.ElizaClient,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  isAuthenticatedNow: () => h.authState.phase === "authenticated",
  subscribeAuthStatus: (listener: (state: { phase: string }) => void) => {
    h.authSubscribers.add(listener);
    return () => h.authSubscribers.delete(listener);
  },
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: h.capacitorGetPlatform,
    isNativePlatform: h.capacitorIsNative,
  },
}));

vi.mock("@elizaos/capacitor-mobile-signals", () => ({
  MobileSignals: h.mobile,
}));

vi.mock("../events/index.js", () => ({
  dispatchLifeOpsActivitySignalsStatus: h.dispatchStatus,
}));

import {
  isLifeOpsActivitySignalCaptureActive,
  startLifeOpsActivitySignalCapture,
} from "./activity-signals-capture.js";

const DEVICE_SNAPSHOT = {
  source: "mobile_device",
  platform: "ios",
  state: "active",
  observedAt: 1_700_000_000_000,
  idleState: "active",
  idleTimeSeconds: 12,
  onBattery: true,
  metadata: { app: "com.example" },
};

const HEALTH_SNAPSHOT = {
  source: "mobile_health",
  platform: "ios",
  state: "sleeping",
  observedAt: 1_700_000_100_000,
  idleState: "idle",
  idleTimeSeconds: null,
  onBattery: null,
  healthSource: "healthkit",
  permissions: { sleep: true, biometrics: true },
  sleep: {
    available: true,
    isSleeping: true,
    asleepAt: 1_699_999_000_000,
    awakeAt: null,
    durationMinutes: 420,
    stage: "core",
  },
  biometrics: {
    sampleAt: 1_700_000_050_000,
    heartRateBpm: 58,
    restingHeartRateBpm: 54,
    heartRateVariabilityMs: 42,
    respiratoryRate: 14,
    bloodOxygenPercent: 98,
  },
  warnings: ["battery low"],
  metadata: { note: "overnight" },
  screenTime: { supported: false, reason: null },
};

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function capturedSources(): string[] {
  return h.captureLifeOpsActivitySignal.mock.calls.map(
    ([signal]) => (signal as { source: string }).source,
  );
}

function mockNativeMobile(): void {
  h.capacitorIsNative.mockReturnValue(true);
  h.capacitorGetPlatform.mockReturnValue("ios");
}

function publishAuthStatus(phase: string): void {
  h.authState = { phase };
  for (const subscriber of h.authSubscribers) {
    subscriber(h.authState);
  }
}

describe("startLifeOpsActivitySignalCapture", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    h.getStatus.mockResolvedValue({ state: "running" });
    h.captureLifeOpsActivitySignal.mockResolvedValue({
      signal: { id: "sig-1" },
    });
    h.isApiError.mockReturnValue(false);
    h.isElectrobunRuntime.mockReturnValue(false);
    h.loadDesktopWorkspaceSnapshot.mockResolvedValue({ supported: false });
    h.authState = { phase: "authenticated" };
    h.authSubscribers.clear();
    h.capacitorGetPlatform.mockReturnValue("web");
    h.capacitorIsNative.mockReturnValue(false);
    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });
    h.mobile.addListener.mockImplementation(
      async (_event: string, cb: (signal: unknown) => void) => {
        h.mobile.listenerCb = cb;
        return { remove: vi.fn(async () => {}) };
      },
    );
    h.mobile.getSnapshot.mockResolvedValue({
      supported: false,
      snapshot: null,
      healthSnapshot: null,
    });
    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    h.mobile.scheduleBackgroundRefresh.mockResolvedValue({ scheduled: true });
    h.mobile.cancelBackgroundRefresh.mockResolvedValue({ cancelled: true });
    h.mobile.listenerCb = null;
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(h.authSubscribers.size).toBe(0);
  });

  it("returns a no-op when disabled and captures nothing", () => {
    stop = startLifeOpsActivitySignalCapture(false);
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(() => stop?.()).not.toThrow();
    stop = undefined;
  });

  it("makes no readiness or capture requests while canonically signed out", async () => {
    vi.useFakeTimers();
    h.authState = { phase: "unauthenticated" };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("starts one readiness loop when a valid session appears", async () => {
    vi.useFakeTimers();
    h.authState = { phase: "unauthenticated" };

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.getStatus).not.toHaveBeenCalled();

    publishAuthStatus("authenticated");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.getStatus).toHaveBeenCalledTimes(1);
    expect(capturedSources()).toEqual(
      expect.arrayContaining(["app_lifecycle", "page_visibility"]),
    );

    // Re-publishing the same canonical state must not duplicate the immediate
    // probe or install a second five-second interval.
    publishAuthStatus("authenticated");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.getStatus).toHaveBeenCalledTimes(2);
  });

  it("quarantines an in-flight readiness result when the session disappears", async () => {
    vi.useFakeTimers();
    h.authState = { phase: "unauthenticated" };
    let resolveStatus: ((status: { state: string }) => void) | undefined;
    h.getStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    publishAuthStatus("authenticated");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.getStatus).toHaveBeenCalledTimes(1);

    publishAuthStatus("unauthenticated");
    resolveStatus?.({ state: "running" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.getStatus).toHaveBeenCalledTimes(1);
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
  });

  it("posts the current web presence once the runtime reports running", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.getStatus).toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    const sources = capturedSources();
    expect(sources).toContain("app_lifecycle");
    expect(sources).toContain("page_visibility");
    for (const [signal] of h.captureLifeOpsActivitySignal.mock.calls) {
      expect((signal as { platform?: string }).platform).toBe("web_app");
    }
  });

  it("is idempotent: a second start returns the active stop without duplicating work", async () => {
    const addDoc = vi.spyOn(document, "addEventListener");
    stop = startLifeOpsActivitySignalCapture(true);
    const listenerInstalls = addDoc.mock.calls.length;

    const second = startLifeOpsActivitySignalCapture(true);
    expect(second).toBe(stop);
    // No additional listeners were installed by the duplicate start.
    expect(addDoc.mock.calls.length).toBe(listenerInstalls);
    expect(h.getStatus).toHaveBeenCalledTimes(1);
    addDoc.mockRestore();
  });

  it("re-initializes cleanly after stop (stop → start → new capture)", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    stop();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);

    stop = startLifeOpsActivitySignalCapture(true);
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    await settle();
    // The restarted capture probes the runtime again.
    expect(h.getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("re-emits presence on visibility, focus, blur, resume and pause", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    h.captureLifeOpsActivitySignal.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("eliza:app-resume"));
    document.dispatchEvent(new Event("eliza:app-pause"));
    await settle();

    const sources = capturedSources();
    expect(
      sources.filter((s) => s === "page_visibility").length,
    ).toBeGreaterThan(0);
    // resume/pause both push an app_lifecycle presence signal.
    expect(sources).toContain("app_lifecycle");
  });

  it("stands down when the runtime is not running", async () => {
    h.getStatus.mockResolvedValue({ state: "stopped" });
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.getStatus).toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
  });

  it("emits the current state once the runtime becomes ready on a later poll", async () => {
    vi.useFakeTimers();
    h.getStatus.mockResolvedValueOnce({ state: "stopped" });
    h.getStatus.mockResolvedValue({ state: "running" });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();

    // The 5s runtime-ready poller flips ready and emits the initial burst.
    await vi.advanceTimersByTimeAsync(5_000);
    const sources = capturedSources();
    expect(sources).toContain("app_lifecycle");
    expect(sources).toContain("page_visibility");
  });

  it("dedupes identical presence signals inside the dedup window", async () => {
    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    h.captureLifeOpsActivitySignal.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();

    const visibilityPosts = h.captureLifeOpsActivitySignal.mock.calls.filter(
      ([signal]) => (signal as { source: string }).source === "page_visibility",
    );
    expect(visibilityPosts.length).toBe(1);
  });

  it("captures a desktop power snapshot on the Electrobun runtime", async () => {
    h.isElectrobunRuntime.mockReturnValue(true);
    h.loadDesktopWorkspaceSnapshot.mockResolvedValue({
      supported: true,
      power: { idleState: "active", idleTime: 3.7, onBattery: false },
      window: { focused: true, visible: true },
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    const desktopCalls = h.captureLifeOpsActivitySignal.mock.calls.filter(
      ([signal]) => (signal as { source: string }).source === "desktop_power",
    );
    expect(desktopCalls.length).toBeGreaterThan(0);
    const [desktopSignal] = desktopCalls[0] as [
      { platform?: string; state: string; idleTimeSeconds?: number },
    ];
    expect(desktopSignal.platform).toBe("desktop_app");
    expect(desktopSignal.state).toBe("active");
    expect(desktopSignal.idleTimeSeconds).toBe(3);
  });

  it("captures and maps native mobile device + health snapshots", async () => {
    mockNativeMobile();
    h.mobile.getSnapshot.mockResolvedValue({
      supported: true,
      snapshot: DEVICE_SNAPSHOT,
      healthSnapshot: HEALTH_SNAPSHOT,
    });
    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: DEVICE_SNAPSHOT,
      healthSnapshot: HEALTH_SNAPSHOT,
    });
    h.mobile.scheduleBackgroundRefresh.mockResolvedValue({
      scheduled: false,
      reason: "os_denied",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.checkPermissions).toHaveBeenCalled();
    expect(h.mobile.startMonitoring).toHaveBeenCalledWith({
      emitInitial: true,
    });

    const sources = capturedSources();
    expect(sources).toContain("mobile_device");
    expect(sources).toContain("mobile_health");

    // The health snapshot is mapped to the capture DTO shape with ISO dates.
    const [healthSignal] = (h.captureLifeOpsActivitySignal.mock.calls.find(
      ([signal]) => (signal as { source: string }).source === "mobile_health",
    ) ?? []) as [
      {
        platform?: string;
        health?: { sleep: { asleepAt: string | null; awakeAt: string | null } };
        metadata?: Record<string, unknown>;
      },
    ];
    expect(healthSignal.platform).toBe("ios");
    expect(healthSignal.health?.sleep.asleepAt).toBe(
      new Date(HEALTH_SNAPSHOT.sleep.asleepAt).toISOString(),
    );
    expect(healthSignal.health?.sleep.awakeAt).toBeNull();
    expect(healthSignal.metadata).toMatchObject({
      screenTime: expect.any(Object),
    });

    // A background-refresh denial surfaces as a status event.
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "background_refresh_unavailable" }),
    );

    // The signal listener drives further captures.
    expect(h.mobile.listenerCb).toBeTypeOf("function");
    h.mobile.listenerCb?.({
      ...DEVICE_SNAPSHOT,
      state: "idle",
      metadata: { app: "x" },
    });
    await settle();
    expect(
      capturedSources().filter((s) => s === "mobile_device").length,
    ).toBeGreaterThan(1);

    stop();
    stop = undefined;
    expect(h.mobile.stopMonitoring).toHaveBeenCalled();
  });

  it("never starts native monitoring without granted permission (consent gate)", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockResolvedValue({ status: "denied" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.checkPermissions).toHaveBeenCalled();
    expect(h.mobile.addListener).not.toHaveBeenCalled();
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "permission_unavailable",
        reason: "denied",
      }),
    );
  });

  it("does not prompt for permission when consent is not yet determined", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockResolvedValue({ status: "not-determined" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "permission_unavailable",
        reason: "not-determined",
      }),
    );
  });

  it("picks up a permission granted later on app resume", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockResolvedValueOnce({ status: "denied" });
    h.mobile.checkPermissions.mockResolvedValue({ status: "granted" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();

    // The user grants consent in OS Settings and returns to the app.
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
  });

  it("stopping during an awaited listener registration removes the late handle", async () => {
    mockNativeMobile();
    const remove = vi.fn(async () => {});
    let releaseAddListener:
      | ((handle: { remove: typeof remove }) => void)
      | undefined;
    h.mobile.addListener.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAddListener = resolve;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.addListener).toHaveBeenCalled();

    stop();
    stop = undefined;
    releaseAddListener?.({ remove });
    await settle();

    // The handle resolved after stop: it must be removed, and monitoring must
    // never have started.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();
  });

  it("stopping during an awaited startMonitoring stops the monitor and installs no late interval", async () => {
    mockNativeMobile();
    let releaseStartMonitoring:
      | ((result: {
          enabled: boolean;
          supported: boolean;
          platform: string;
          snapshot: null;
          healthSnapshot: null;
        }) => void)
      | undefined;
    h.mobile.startMonitoring.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStartMonitoring = resolve;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.startMonitoring).toHaveBeenCalled();

    const setIntervalSpy = vi.spyOn(window, "setInterval");
    stop();
    stop = undefined;
    releaseStartMonitoring?.({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    await settle();

    // The monitor that engaged after stop is stood down, and the five-minute
    // health poller is never installed.
    expect(h.mobile.stopMonitoring).toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it("does not double-start native monitoring from concurrent triggers", async () => {
    mockNativeMobile();
    let releasePermissions: ((status: { status: string }) => void) | undefined;
    h.mobile.checkPermissions.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePermissions = resolve;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(1);

    // While the first start is parked on checkPermissions, app resumes retry
    // the start; the in-flight guard must absorb them.
    document.dispatchEvent(new Event("eliza:app-resume"));
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();
    releasePermissions?.({ status: "granted" });
    await settle();

    expect(h.mobile.checkPermissions).toHaveBeenCalledTimes(1);
    expect(h.mobile.addListener).toHaveBeenCalledTimes(1);
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
  });

  it("surfaces unexpected capture failures as a capture_error status event", async () => {
    h.captureLifeOpsActivitySignal.mockRejectedValue(new Error("boom"));

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error", message: "boom" }),
    );
  });

  it("stands down when the native MobileSignals plugin is intentionally absent", async () => {
    mockNativeMobile();
    h.mobile.checkPermissions.mockRejectedValue(
      new Error('"MobileSignals" plugin is not implemented on android'),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
    expect(h.mobile.startMonitoring).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected (non-transport) status-probe failure instead of reading it as not-ready", async () => {
    h.getStatus.mockRejectedValue(new TypeError("status DTO shape broken"));

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    // No capture happens (the probe failed) …
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    // … but the failure is observable, not collapsed into silent not-ready.
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "capture_error",
        message: "status DTO shape broken",
      }),
    );
  });

  it("treats a transport-level status-probe failure as expected runtime unavailability", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({ kind: "network" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
  });

  it("treats a 503 status-probe response as expected runtime unavailability", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({ kind: "http", status: 503 });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
  });

  it("treats a 404 status-probe response as expected (no status endpoint at this base — cloud console)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({ kind: "http", status: 404 });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("treats a 401 status-probe response as the expected signed-out state (no console error, no status event)", async () => {
    vi.useFakeTimers();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({ kind: "http", status: 401 });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(h.getStatus).toHaveBeenCalledTimes(1);
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("treats a 403 status-probe response as the expected signed-out state", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({ kind: "http", status: 403 });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
  });

  it("swallows a 401 on the capture endpoint as the signed-out state (session expired mid-capture)", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({
      kind: "http",
      status: 401,
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );

    h.captureLifeOpsActivitySignal.mockClear();
    window.dispatchEvent(new Event("blur"));
    await settle();
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
  });

  it("treats a structural agent-gone status probe (stale binding to a deleted agent) as an expected stand-down", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    // The cloud router's code-less shape for a deleted agent's origin.
    h.getStatus.mockRejectedValue(
      Object.assign(new Error("agent not found or not running"), {
        kind: "http",
        status: 404,
      }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("swallows an agent_not_found capture failure (agent deleted mid-session) without a capture_error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue(
      Object.assign(new Error("agent not found"), {
        kind: "http",
        status: 404,
        code: "agent_not_found",
      }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("still surfaces an ordinary 404 (missing route, no agent-gone shape) as a capture_error", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({
      kind: "http",
      status: 404,
      message: "Not Found",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("backs off a capability-specific 503 and resumes after a bounded probe", async () => {
    vi.useFakeTimers();
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({
      kind: "http",
      status: 503,
      path: "/api/lifeops/activity-signals",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();

    h.captureLifeOpsActivitySignal.mockClear();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(h.getStatus.mock.calls.length).toBeGreaterThan(1);
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();

    h.captureLifeOpsActivitySignal.mockResolvedValue({
      signal: { id: "sig-recovered" },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
  });

  it("surfaces a persistent 5xx status-probe failure instead of reading it as not-ready forever", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.getStatus.mockRejectedValue({
      kind: "http",
      status: 500,
      message: "status endpoint exploded",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("silently swallows transient network errors without a status event", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({ kind: "network" });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("stops sending after a 503 runtime-unavailable response", async () => {
    h.isApiError.mockImplementation(
      (error) => typeof error === "object" && error !== null && "kind" in error,
    );
    h.captureLifeOpsActivitySignal.mockRejectedValue({
      kind: "http",
      status: 503,
      path: "/api/lifeops/activity-signals",
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });

  it("removes every listener and interval on stop", async () => {
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const removeWin = vi.spyOn(window, "removeEventListener");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    stop();
    stop = undefined;

    expect(removeDoc).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeWin).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith("blur", expect.any(Function));
    // Ready poller + heartbeat + desktop poller are all cleared.
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    removeDoc.mockRestore();
    removeWin.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("rolls back the listener when startMonitoring resolves enabled:false, allowing a later retry (#17110)", async () => {
    mockNativeMobile();
    const remove = vi.fn(async () => {});
    h.mobile.addListener.mockImplementation(
      async (_event: string, cb: (signal: unknown) => void) => {
        h.mobile.listenerCb = cb;
        return { remove };
      },
    );
    h.mobile.startMonitoring.mockResolvedValueOnce({
      enabled: false,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);
    // Never committed: the rejected/disabled handle is rolled back instead of
    // wedging the guard for every later retry.
    expect(remove).toHaveBeenCalledTimes(1);

    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
  });

  it("rolls back the listener when startMonitoring rejects, allowing a later retry (#17110)", async () => {
    mockNativeMobile();
    const remove = vi.fn(async () => {});
    h.mobile.addListener.mockImplementation(
      async (_event: string, cb: (signal: unknown) => void) => {
        h.mobile.listenerCb = cb;
        return { remove };
      },
    );
    h.mobile.startMonitoring.mockRejectedValueOnce(
      new Error("native start failed"),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(remove).toHaveBeenCalledTimes(1);

    h.mobile.startMonitoring.mockResolvedValue({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    document.dispatchEvent(new Event("eliza:app-resume"));
    await settle();

    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(2);
  });

  it("cancels the scheduled background refresh on stop (#17110)", async () => {
    mockNativeMobile();
    h.mobile.scheduleBackgroundRefresh.mockResolvedValue({ scheduled: true });

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.mobile.scheduleBackgroundRefresh).toHaveBeenCalled();

    stop();
    stop = undefined;

    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalledTimes(1);
  });

  it("stop() awaits an in-flight native startup's rollback before resolving (#17110)", async () => {
    mockNativeMobile();
    const remove = vi.fn(async () => {});
    h.mobile.addListener.mockImplementation(
      async (_event: string, cb: (signal: unknown) => void) => {
        h.mobile.listenerCb = cb;
        return { remove };
      },
    );
    let releaseStartMonitoring: ((value: unknown) => void) | undefined;
    h.mobile.startMonitoring.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStartMonitoring = resolve;
        }),
    );

    const stopFn = startLifeOpsActivitySignalCapture(true);
    stop = stopFn;
    await settle();
    expect(h.mobile.startMonitoring).toHaveBeenCalledTimes(1);

    let stopSettled = false;
    const stopPromise = Promise.resolve(stopFn()).then(() => {
      stopSettled = true;
    });
    stop = undefined;
    await settle();
    // The in-flight startup (startMonitoring pending) is owned teardown
    // work: stop() must not resolve until its rollback has completed, or the
    // registry would start a successor the late rollback can then disable.
    expect(stopSettled).toBe(false);

    releaseStartMonitoring?.({
      enabled: true,
      supported: true,
      platform: "ios",
      snapshot: null,
      healthSnapshot: null,
    });
    await settle();
    await stopPromise;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(h.mobile.stopMonitoring).toHaveBeenCalledTimes(1);
  });

  it("re-cancels a background refresh that resolves after stop (#17110)", async () => {
    mockNativeMobile();
    let releaseSchedule: ((value: unknown) => void) | undefined;
    h.mobile.scheduleBackgroundRefresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSchedule = resolve;
        }),
    );

    const stopFn = startLifeOpsActivitySignalCapture(true);
    stop = stopFn;
    await settle();
    expect(h.mobile.scheduleBackgroundRefresh).toHaveBeenCalledTimes(1);

    let stopSettled = false;
    const stopPromise = Promise.resolve(stopFn()).then(() => {
      stopSettled = true;
    });
    stop = undefined;
    await settle();
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalledTimes(1);
    // The pending schedule is owned work: stop() may not resolve while a
    // late `{ scheduled: true }` can still create a background job that no
    // live generation owns.
    expect(stopSettled).toBe(false);

    releaseSchedule?.({ scheduled: true });
    await settle();
    await stopPromise;
    // The late schedule landed after stop's cancel — it must be cancelled
    // again before cleanup resolves.
    expect(h.mobile.cancelBackgroundRefresh).toHaveBeenCalledTimes(2);
  });

  it("discards a late in-flight capture-signal failure after stop instead of publishing it (#17110)", async () => {
    let rejectCapture: ((error: unknown) => void) | undefined;
    h.captureLifeOpsActivitySignal.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCapture = reject;
        }),
    );

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();
    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();
    const callsBeforeStop = h.captureLifeOpsActivitySignal.mock.calls.length;

    stop();
    stop = undefined;

    // The in-flight call resolves late, after stop.
    rejectCapture?.(new Error("late failure after stop"));
    await settle();

    // No new client call was made because of the stop, and the late failure
    // was discarded rather than published as a capture_error.
    expect(h.captureLifeOpsActivitySignal.mock.calls.length).toBe(
      callsBeforeStop,
    );
    expect(h.dispatchStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error" }),
    );
  });
});
