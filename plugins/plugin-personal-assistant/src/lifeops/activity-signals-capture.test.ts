/**
 * @vitest-environment jsdom
 *
 * Drives the imperative activity-signal capture controller against a mocked
 * ElizaClient + browser environment across all three device shapes (web,
 * desktop/Electrobun, native mobile). Proves it posts presence once the runtime
 * reports running, re-emits on lifecycle/visibility events, dedupes rapid
 * repeats, maps native mobile snapshots, degrades quietly on runtime-unavailable
 * / network errors, surfaces unexpected failures as a status event, and fully
 * tears down its listeners/intervals on stop.
 *
 * `@elizaos/ui`, `@elizaos/ui/api`, and `@elizaos/ui/browser` all alias to the
 * same stub file under this package's vitest config, so a single complete mock
 * factory is shared across the three specifiers — otherwise the last `vi.mock`
 * wins and drops exports the earlier specifiers need (e.g. isElectrobunRuntime).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const mobile = {
    listenerCb: null as null | ((signal: unknown) => void),
    checkPermissions: vi.fn(async () => ({})),
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
  };
  return {
    getStatus: vi.fn(async () => ({ state: "running" })),
    captureLifeOpsActivitySignal: vi.fn(async () => ({
      signal: { id: "sig-1" },
    })),
    isApiError: vi.fn((_error: unknown) => false),
    isElectrobunRuntime: vi.fn(() => false),
    loadDesktopWorkspaceSnapshot: vi.fn(async () => ({ supported: false })),
    dispatchStatus: vi.fn(),
    capacitorGetPlatform: vi.fn(() => "web"),
    capacitorIsNative: vi.fn(() => false),
    mobile,
  };
});

// The three @elizaos/ui specifiers (root barrel, /api, /browser) all alias to
// the same stub file under this package's vitest config, so each mock returns
// the same shape: events + client + isElectrobunRuntime (root), isApiError
// (/api), loadDesktopWorkspaceSnapshot (/browser). The object literal is inlined
// per call and reads only the hoisted `h` — any module-scope const would sit in
// its TDZ when the hoisted `vi.mock` and source import run.
vi.mock("@elizaos/ui", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
}));
vi.mock("@elizaos/ui/api", () => ({
  isApiError: h.isApiError,
  isElectrobunRuntime: h.isElectrobunRuntime,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));
vi.mock("@elizaos/ui/browser", () => ({
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
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

import { startLifeOpsActivitySignalCapture } from "./activity-signals-capture.js";

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
    h.capacitorGetPlatform.mockReturnValue("web");
    h.capacitorIsNative.mockReturnValue(false);
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
    h.mobile.listenerCb = null;
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it("returns a no-op when disabled and captures nothing", () => {
    stop = startLifeOpsActivitySignalCapture(false);
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).not.toHaveBeenCalled();
    expect(() => stop?.()).not.toThrow();
    stop = undefined;
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
    h.capacitorIsNative.mockReturnValue(true);
    h.capacitorGetPlatform.mockReturnValue("ios");
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

  it("surfaces unexpected capture failures as a capture_error status event", async () => {
    h.captureLifeOpsActivitySignal.mockRejectedValue(new Error("boom"));

    stop = startLifeOpsActivitySignalCapture(true);
    await settle();

    expect(h.dispatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "capture_error", message: "boom" }),
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
    expect(clearIntervalSpy).toHaveBeenCalled();

    removeDoc.mockRestore();
    removeWin.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
