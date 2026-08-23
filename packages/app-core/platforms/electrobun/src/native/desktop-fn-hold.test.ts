/**
 * Covers the DesktopManager fn-hold push-to-talk bridge (#20483): start
 * results, drain/dedupe of native fn transitions into desktopFnHoldChanged
 * pushes, chord-cancel semantics, overflow resync against physical key state,
 * the tap-health watchdog restart, and teardown. The native CGEventTap layer
 * is mocked; the timers and manager wiring under test are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FnMonitorEvent,
  FnMonitorStartResult,
} from "./mac-window-effects";

const fnMock = vi.hoisted(() => ({
  startResult: "started" as FnMonitorStartResult,
  queue: [] as FnMonitorEvent[],
  healthy: true,
  fnDown: false,
  usageType: 0,
  startCalls: 0,
  stopCalls: 0,
}));

vi.mock("./mac-window-effects", () => ({
  createSecurityScopedBookmark: vi.fn(() => null),
  enableVibrancy: vi.fn(() => false),
  setWindowShadow: vi.fn(() => false),
  isAppActive: vi.fn(() => false),
  isKeyWindow: vi.fn(() => false),
  makeKeyAndOrderFront: vi.fn(),
  orderOut: vi.fn(),
  setNativeDragRegion: vi.fn(),
  setTrafficLightsPosition: vi.fn(),
  startAccessingSecurityScopedBookmark: vi.fn(() => false),
  stopAccessingSecurityScopedBookmarks: vi.fn(),
  startFnMonitor: vi.fn(() => {
    fnMock.startCalls += 1;
    return fnMock.startResult;
  }),
  stopFnMonitor: vi.fn(() => {
    fnMock.stopCalls += 1;
  }),
  pollFnMonitor: vi.fn(() => fnMock.queue.shift() ?? null),
  isFnMonitorHealthy: vi.fn(() => fnMock.healthy),
  isFnKeyDown: vi.fn(() => fnMock.fnDown),
  getFnSystemUsageType: vi.fn(() => fnMock.usageType),
}));

vi.mock("electrobun/bun", () => ({
  default: {},
  BrowserView: vi.fn(),
  BuildConfig: { get: () => ({}) },
  ContextMenu: { on: vi.fn() },
  GlobalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
    isRegistered: vi.fn(() => false),
  },
  Screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 2,
    })),
  },
  Session: {},
  Tray: vi.fn(),
  Updater: {},
  Utils: {
    quit: vi.fn(),
    openExternal: vi.fn(),
    showNotification: vi.fn(),
    paths: {},
  },
}));

import { DesktopManager } from "./desktop";

const darwinOnly = process.platform === "darwin" ? describe : describe.skip;

function createManager() {
  const pushes: Array<{ message: string; payload: unknown }> = [];
  const manager = new DesktopManager();
  manager.setSendToWebview((message, payload) => {
    pushes.push({ message, payload });
  });
  const fnPushes = () =>
    pushes.filter((entry) => entry.message === "desktopFnHoldChanged");
  const shortcutPushes = () =>
    pushes.filter((entry) => entry.message === "desktopShortcutPressed");
  return { manager, fnPushes, shortcutPushes };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fnMock.startResult = "started";
  fnMock.queue = [];
  fnMock.healthy = true;
  fnMock.fnDown = false;
  fnMock.usageType = 0;
  fnMock.startCalls = 0;
  fnMock.stopCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

darwinOnly("DesktopManager fn-hold push-to-talk bridge", () => {
  it("reports start status and the system fn usage setting", async () => {
    const { manager } = createManager();
    fnMock.usageType = 3;
    await expect(manager.startFnHoldMonitor()).resolves.toEqual({
      status: "started",
      fnSystemUsageType: 3,
    });
    await manager.stopFnHoldMonitor();
  });

  it("surfaces permission-missing without starting the poller", async () => {
    const { manager, fnPushes } = createManager();
    fnMock.startResult = "permission-missing";
    const result = await manager.startFnHoldMonitor();
    expect(result.status).toBe("permission-missing");
    fnMock.queue = ["down"];
    vi.advanceTimersByTime(200);
    expect(fnPushes()).toHaveLength(0);
    await manager.stopFnHoldMonitor();
  });

  it("forwards a hold as held:true then a plain release as a send", async () => {
    const { manager, fnPushes } = createManager();
    await manager.startFnHoldMonitor();

    fnMock.queue = ["down"];
    fnMock.fnDown = true;
    vi.advanceTimersByTime(20);
    expect(fnPushes()).toEqual([
      {
        message: "desktopFnHoldChanged",
        payload: { held: true, cancelled: false },
      },
    ]);

    fnMock.queue = ["up"];
    fnMock.fnDown = false;
    vi.advanceTimersByTime(20);
    expect(fnPushes()[1]).toEqual({
      message: "desktopFnHoldChanged",
      payload: { held: false, cancelled: false },
    });
    await manager.stopFnHoldMonitor();
  });

  it("marks a chorded release as cancelled", async () => {
    const { manager, fnPushes } = createManager();
    await manager.startFnHoldMonitor();

    fnMock.queue = ["down"];
    fnMock.fnDown = true;
    vi.advanceTimersByTime(20);
    fnMock.queue = ["up-chord"];
    fnMock.fnDown = false;
    vi.advanceTimersByTime(20);

    expect(fnPushes()[1]).toEqual({
      message: "desktopFnHoldChanged",
      payload: { held: false, cancelled: true },
    });
    await manager.stopFnHoldMonitor();
  });

  it("dedupes repeated downs and ignores unpaired releases", async () => {
    const { manager, fnPushes } = createManager();
    await manager.startFnHoldMonitor();

    fnMock.queue = ["up", "down", "down"];
    fnMock.fnDown = true;
    vi.advanceTimersByTime(20);
    expect(fnPushes()).toHaveLength(1);
    expect(fnPushes()[0]?.payload).toEqual({ held: true, cancelled: false });
    await manager.stopFnHoldMonitor();
  });

  it("toggles the existing window natively for each drained Option chord", async () => {
    const { manager, fnPushes, shortcutPushes } = createManager();
    const window = {
      ptr: 1,
      on: vi.fn(),
      off: vi.fn(),
      isMinimized: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      focus: vi.fn(),
    };
    manager.setMainWindow(
      window as unknown as Parameters<typeof manager.setMainWindow>[0],
    );
    await manager.startFnHoldMonitor();

    fnMock.queue = ["both-options"];
    await vi.advanceTimersByTimeAsync(20);

    const { orderOut, makeKeyAndOrderFront } = await import(
      "./mac-window-effects"
    );
    expect(orderOut).toHaveBeenCalledTimes(1);

    fnMock.queue = ["both-options"];
    await vi.advanceTimersByTimeAsync(20);

    expect(makeKeyAndOrderFront).toHaveBeenCalledTimes(1);
    expect(shortcutPushes()).toHaveLength(0);
    expect(fnPushes()).toHaveLength(0);
    await manager.stopFnHoldMonitor();
  });

  it("resyncs a stale held state from the physical key on queue overflow", async () => {
    const { manager, fnPushes } = createManager();
    await manager.startFnHoldMonitor();

    fnMock.queue = ["down"];
    fnMock.fnDown = true;
    vi.advanceTimersByTime(20);
    // The "up" transition was dropped (ring overflow): queue empty but the
    // physical key is no longer down.
    fnMock.fnDown = false;
    vi.advanceTimersByTime(20);

    expect(fnPushes()[1]).toEqual({
      message: "desktopFnHoldChanged",
      payload: { held: false, cancelled: true },
    });
    await manager.stopFnHoldMonitor();
  });

  it("watchdog restarts the tap when macOS disables it", async () => {
    const { manager } = createManager();
    await manager.startFnHoldMonitor();
    expect(fnMock.startCalls).toBe(1);

    fnMock.healthy = false;
    vi.advanceTimersByTime(5_100);
    expect(fnMock.stopCalls).toBeGreaterThanOrEqual(1);
    expect(fnMock.startCalls).toBeGreaterThanOrEqual(2);
    await manager.stopFnHoldMonitor();
  });

  it("stop mid-hold pushes a cancelled release and stops the native tap", async () => {
    const { manager, fnPushes } = createManager();
    await manager.startFnHoldMonitor();

    fnMock.queue = ["down"];
    fnMock.fnDown = true;
    vi.advanceTimersByTime(20);
    await manager.stopFnHoldMonitor();

    expect(fnPushes()[1]).toEqual({
      message: "desktopFnHoldChanged",
      payload: { held: false, cancelled: true },
    });
    expect(fnMock.stopCalls).toBeGreaterThanOrEqual(1);

    // Poller is gone: further native events produce no pushes.
    fnMock.queue = ["down"];
    vi.advanceTimersByTime(100);
    expect(fnPushes()).toHaveLength(2);
  });
});

describe("DesktopManager fn-hold on non-mac platforms", () => {
  it("reports unavailable without touching the native layer", async () => {
    if (process.platform === "darwin") {
      // Covered by the darwin suite; the guard under test is the
      // process.platform branch, which cannot be exercised from darwin.
      return;
    }
    const { manager } = createManager();
    await expect(manager.startFnHoldMonitor()).resolves.toEqual({
      status: "unavailable",
      fnSystemUsageType: 0,
    });
    expect(fnMock.startCalls).toBe(0);
  });
});
