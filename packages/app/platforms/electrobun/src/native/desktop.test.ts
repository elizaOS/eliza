/**
 * Exercises DesktopManager exports against the real module with injected native
 * seams. Electrobun and macOS FFI are stubbed so path mapping, power-state
 * probes, shortcut ownership, and notification diagnostics run without spawning
 * host subprocesses.
 */

import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBrandConfig } from "../brand-config";
import {
  DesktopManager,
  getDesktopManager,
  resetDesktopManagerForTesting,
  setNativeShellRunnerForTesting,
} from "./desktop";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    clearWorkspaceFolderConfig: vi.fn(),
    writeWorkspaceFolderConfig: vi.fn(),
  };
});

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
  startFnMonitor: vi.fn(() => "unavailable" as const),
  stopFnMonitor: vi.fn(),
  pollFnMonitor: vi.fn(() => null),
  isFnMonitorHealthy: vi.fn(() => false),
  isFnKeyDown: vi.fn(() => false),
  getFnSystemUsageType: vi.fn(() => 0),
}));

const electrobunMock = vi.hoisted(() => {
  const PATHS = {
    home: "/mock/home",
    appData: "/mock/appData",
    userData: "/mock/userData",
    userCache: "/mock/userCache",
    userLogs: "/mock/userLogs",
    temp: "/mock/temp",
    cache: "/mock/cache",
    logs: "/mock/logs",
    config: "/mock/config",
    documents: "/mock/documents",
    downloads: "/mock/downloads",
    desktop: "/mock/desktop",
    pictures: "/mock/pictures",
    music: "/mock/music",
    videos: "/mock/videos",
  };
  const GlobalShortcut = {
    isRegistered: vi.fn(() => false),
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  };
  const Utils = {
    clipboardAvailableFormats: vi.fn(() => ["text/plain"]),
    clipboardClear: vi.fn(),
    clipboardReadImage: vi.fn(() => new Uint8Array([1])),
    clipboardReadText: vi.fn(() => "copied"),
    clipboardWriteImage: vi.fn(),
    clipboardWriteText: vi.fn(),
    isDockIconVisible: vi.fn(() => true),
    openExternal: vi.fn(),
    openFileDialog: vi.fn(async () => [] as string[]),
    openPath: vi.fn(),
    paths: PATHS,
    quit: vi.fn(),
    setDockIconVisible: vi.fn(),
    showItemInFolder: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showNotification: vi.fn(),
  };
  const Screen = {
    getAllDisplays: vi.fn(() => []),
    getCursorScreenPoint: vi.fn(() => ({ x: 12, y: 34 })),
    getPrimaryDisplay: vi.fn(() => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      scaleFactor: 2,
      isPrimary: true,
    })),
  };
  const BuildConfig = {
    get: vi.fn(async () => ({
      defaultRenderer: "native" as const,
      availableRenderers: ["native"] as string[],
      cefVersion: "cef-test",
      bunVersion: "bun-test",
      runtime: "test",
    })),
  };
  const Updater = {
    localInfo: {
      version: vi.fn(async () => "1.2.3"),
    },
  };
  return {
    PATHS,
    GlobalShortcut,
    Utils,
    Screen,
    BuildConfig,
    Updater,
    ContextMenu: { on: vi.fn(), showContextMenu: vi.fn() },
    events: { on: vi.fn(), off: vi.fn() },
    reset() {
      GlobalShortcut.isRegistered.mockClear();
      GlobalShortcut.register.mockClear();
      GlobalShortcut.unregister.mockClear();
      GlobalShortcut.unregisterAll.mockClear();
      GlobalShortcut.register.mockReturnValue(true);
      GlobalShortcut.isRegistered.mockReturnValue(false);
      BuildConfig.get.mockClear();
      BuildConfig.get.mockResolvedValue({
        defaultRenderer: "native",
        availableRenderers: ["native"],
        cefVersion: "cef-test",
        bunVersion: "bun-test",
        runtime: "test",
      });
      Updater.localInfo.version.mockClear();
      Updater.localInfo.version.mockResolvedValue("1.2.3");
      Screen.getAllDisplays.mockClear();
      Screen.getCursorScreenPoint.mockClear();
      Screen.getPrimaryDisplay.mockClear();
      Utils.openFileDialog.mockClear();
      Utils.openFileDialog.mockResolvedValue([]);
      Utils.showMessageBox.mockClear();
      Utils.showNotification.mockClear();
      Utils.setDockIconVisible.mockClear();
      Utils.isDockIconVisible.mockClear();
    },
  };
});

vi.mock("electrobun/bun", () => ({
  default: { events: electrobunMock.events },
  BrowserWindow: vi.fn(),
  BrowserView: vi.fn(),
  BuildConfig: electrobunMock.BuildConfig,
  ContextMenu: electrobunMock.ContextMenu,
  GlobalShortcut: electrobunMock.GlobalShortcut,
  Screen: electrobunMock.Screen,
  Session: { defaultSession: {} },
  Tray: vi.fn(),
  Updater: electrobunMock.Updater,
  Utils: electrobunMock.Utils,
}));

const MACOS_CGSESSION_PATH =
  "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";

const PATH_NAMES = [
  "home",
  "appData",
  "userData",
  "userCache",
  "userLogs",
  "temp",
  "cache",
  "logs",
  "config",
  "documents",
  "downloads",
  "desktop",
  "pictures",
  "music",
  "videos",
] as const;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function hidIdleNs(seconds: number): string {
  return `"HIDIdleTime" = ${seconds * 1_000_000_000}`;
}

describe("DesktopManager singleton and test seams", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
    setNativeShellRunnerForTesting(null);
  });

  afterEach(() => {
    setNativeShellRunnerForTesting(null);
    setPlatform(originalPlatform);
    resetDesktopManagerForTesting();
    vi.restoreAllMocks();
  });

  it("returns the same getDesktopManager instance across calls", () => {
    const first = getDesktopManager();
    const second = getDesktopManager();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(DesktopManager);
    expect(new DesktopManager()).not.toBe(first);
  });

  it("does not replace the getDesktopManager singleton when reset", () => {
    const before = getDesktopManager();
    resetDesktopManagerForTesting();
    expect(getDesktopManager()).toBe(before);
  });
});

describe("DesktopManager path mapping", () => {
  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
  });

  afterEach(() => {
    resetDesktopManagerForTesting();
  });

  it("maps every known path name to the Electrobun Utils.paths value captured at load", async () => {
    const manager = new DesktopManager();
    for (const name of PATH_NAMES) {
      await expect(manager.getPath({ name })).resolves.toEqual({
        path: electrobunMock.PATHS[name],
      });
    }
  });

  it("falls back to userData for an unknown path name", async () => {
    const manager = new DesktopManager();
    await expect(manager.getPath({ name: "not-a-real-path" })).resolves.toEqual(
      {
        path: electrobunMock.PATHS.userData,
      },
    );
  });
});

describe("DesktopManager power state via injected shell runner", () => {
  const originalPlatform = process.platform;
  const originalSessionId = process.env.XDG_SESSION_ID;

  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
  });

  afterEach(() => {
    setNativeShellRunnerForTesting(null);
    setPlatform(originalPlatform);
    if (originalSessionId === undefined) {
      delete process.env.XDG_SESSION_ID;
    } else {
      process.env.XDG_SESSION_ID = originalSessionId;
    }
    vi.restoreAllMocks();
    resetDesktopManagerForTesting();
  });

  it("returns the unknown stub when a darwin probe throws", async () => {
    setPlatform("darwin");
    setNativeShellRunnerForTesting({
      read: async () => {
        throw new Error("pmset missing");
      },
      readSafe: async () => null,
    });
    const manager = new DesktopManager();
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: "unknown",
      idleTime: 0,
    });
  });

  it("reports darwin battery, idle, locked, active, and unknown idleState branches", async () => {
    setPlatform("darwin");
    const sessionExists = fs.existsSync(MACOS_CGSESSION_PATH);
    const manager = new DesktopManager();

    setNativeShellRunnerForTesting({
      async read(argv) {
        const joined = argv.join(" ");
        if (argv[0] === "pmset") return "Now drawing from 'Battery Power'";
        if (argv[0] === "ioreg") return hidIdleNs(10);
        if (joined.includes("CGSession")) return "CGSSessionScreenIsLocked = 1";
        throw new Error(`unexpected read ${joined}`);
      },
      readSafe: async () => null,
    });
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: true,
      idleState: sessionExists ? "locked" : "unknown",
      idleTime: 10,
    });

    setNativeShellRunnerForTesting({
      async read(argv) {
        if (argv[0] === "pmset") return "Now drawing from 'AC Power'";
        if (argv[0] === "ioreg") return hidIdleNs(60);
        if (argv.join(" ").includes("CGSession")) {
          return "CGSSessionScreenIsLocked = 0";
        }
        throw new Error(`unexpected read ${argv.join(" ")}`);
      },
      readSafe: async () => null,
    });
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: "idle",
      idleTime: 60,
    });

    setNativeShellRunnerForTesting({
      async read(argv) {
        if (argv[0] === "pmset") return "Now drawing from 'AC Power'";
        if (argv[0] === "ioreg") return hidIdleNs(5);
        if (argv.join(" ").includes("CGSession")) {
          return "CGSSessionScreenIsLocked = 0";
        }
        throw new Error(`unexpected read ${argv.join(" ")}`);
      },
      readSafe: async () => null,
    });
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: sessionExists ? "active" : "unknown",
      idleTime: 5,
    });

    setNativeShellRunnerForTesting({
      async read(argv) {
        if (argv[0] === "pmset") return "unparseable power source";
        if (argv[0] === "ioreg") return "no HIDIdleTime field";
        if (argv.join(" ").includes("CGSession")) {
          return "session lock field absent";
        }
        throw new Error(`unexpected read ${argv.join(" ")}`);
      },
      readSafe: async () => null,
    });
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: "unknown",
      idleTime: 0,
    });
  });

  it("does not query loginctl on linux when XDG_SESSION_ID is missing", async () => {
    setPlatform("linux");
    delete process.env.XDG_SESSION_ID;
    const calls: string[][] = [];
    setNativeShellRunnerForTesting({
      read: async (argv) => {
        calls.push(argv);
        return "";
      },
      readSafe: async (argv) => {
        calls.push(argv);
        return "5000";
      },
    });
    const manager = new DesktopManager();
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: "active",
      idleTime: 5,
    });
    expect(calls.some((argv) => argv[0] === "loginctl")).toBe(false);
    expect(calls.some((argv) => argv[0] === "xprintidle")).toBe(true);
  });

  it("reports linux locked, idle, unknown, and single-element xprintidle states", async () => {
    setPlatform("linux");
    process.env.XDG_SESSION_ID = "42";
    const manager = new DesktopManager();

    setNativeShellRunnerForTesting({
      read: async () => "",
      async readSafe(argv) {
        if (argv[0] === "xprintidle") return "0";
        if (argv[0] === "loginctl") return "LockedHint=yes";
        return null;
      },
    });
    await expect(manager.getPowerState()).resolves.toMatchObject({
      idleState: "locked",
      idleTime: 0,
    });

    setNativeShellRunnerForTesting({
      read: async () => "",
      async readSafe(argv) {
        if (argv[0] === "xprintidle") return "120000";
        if (argv[0] === "loginctl") return "LockedHint=no";
        return null;
      },
    });
    await expect(manager.getPowerState()).resolves.toMatchObject({
      idleState: "idle",
      idleTime: 120,
    });

    setNativeShellRunnerForTesting({
      read: async () => "",
      async readSafe(argv) {
        if (argv[0] === "xprintidle") return null;
        if (argv[0] === "loginctl") return "LockedHint=no";
        return null;
      },
    });
    await expect(manager.getPowerState()).resolves.toMatchObject({
      idleState: "unknown",
      idleTime: 0,
    });
  });

  it("reports windows battery, lock, idle, and missing-probe branches", async () => {
    setPlatform("win32");
    const manager = new DesktopManager();

    setNativeShellRunnerForTesting({
      read: async () => "",
      async readSafe(argv) {
        const command = argv.join(" ");
        if (command.includes("PowerLineStatus")) return "Offline";
        if (command.includes("logonui")) return "1";
        if (command.includes("GetLastInputInfo")) return "1000";
        return null;
      },
    });
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: true,
      idleState: "locked",
      idleTime: 1,
    });

    setNativeShellRunnerForTesting({
      read: async () => "",
      async readSafe(argv) {
        const command = argv.join(" ");
        if (command.includes("PowerLineStatus")) return "Online";
        if (command.includes("logonui")) return "0";
        if (command.includes("GetLastInputInfo")) return "70000";
        return null;
      },
    });
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: "idle",
      idleTime: 70,
    });

    setNativeShellRunnerForTesting({
      read: async () => "",
      readSafe: async () => null,
    });
    await expect(manager.getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: "unknown",
      idleTime: 0,
    });
  });

  it("returns the unknown stub on an unsupported platform", async () => {
    setPlatform("freebsd" as NodeJS.Platform);
    setNativeShellRunnerForTesting({
      read: async () => {
        throw new Error("should not probe");
      },
      readSafe: async () => {
        throw new Error("should not probe");
      },
    });
    await expect(new DesktopManager().getPowerState()).resolves.toEqual({
      onBattery: false,
      idleState: "unknown",
      idleTime: 0,
    });
  });
});

describe("DesktopManager shortcuts, notifications, and callbacks", () => {
  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
  });

  afterEach(() => {
    resetDesktopManagerForTesting();
    delete process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS;
    delete process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_RESET;
    delete process.env.ELECTROBUN_DEV;
  });

  it("treats a same-accelerator re-register as success without calling the OS again", async () => {
    const manager = new DesktopManager();
    const shortcut = {
      id: "palette",
      accelerator: "CommandOrControl+K",
    };

    await expect(manager.registerShortcut(shortcut)).resolves.toEqual({
      success: true,
    });
    await expect(manager.registerShortcut(shortcut)).resolves.toEqual({
      success: true,
    });
    expect(electrobunMock.GlobalShortcut.register).toHaveBeenCalledTimes(1);
    expect(electrobunMock.GlobalShortcut.unregister).not.toHaveBeenCalled();
  });

  it("is a no-op when unregistering a missing shortcut id", async () => {
    const manager = new DesktopManager();
    await manager.unregisterShortcut({ id: "never-registered" });
    expect(electrobunMock.GlobalShortcut.unregister).not.toHaveBeenCalled();
    expect(manager.pressRegisteredShortcut({ id: "never-registered" })).toBe(
      false,
    );
  });

  it("clears tracked shortcuts on unregisterAllShortcuts", async () => {
    const manager = new DesktopManager();
    await manager.registerShortcut({
      id: "palette",
      accelerator: "CommandOrControl+K",
    });
    await manager.unregisterAllShortcuts();
    expect(electrobunMock.GlobalShortcut.unregisterAll).toHaveBeenCalledTimes(
      1,
    );
    expect(manager.pressRegisteredShortcut({ id: "palette" })).toBe(false);
  });

  it("keeps an empty notification diagnostic queue until the first show", async () => {
    const manager = new DesktopManager();
    expect(manager.getNotificationDiagnostics()).toEqual([]);
  });

  it("records a single notification and returns a copy of the queue", async () => {
    const manager = new DesktopManager();
    await expect(
      manager.showNotification({ title: "One", body: "only" }),
    ).resolves.toEqual({ id: "notification_1" });

    const snapshot = manager.getNotificationDiagnostics();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id: "notification_1",
      title: "One",
      body: "only",
    });
    snapshot[0].title = "mutated";
    snapshot.pop();
    expect(manager.getNotificationDiagnostics()).toEqual([
      expect.objectContaining({ id: "notification_1", title: "One" }),
    ]);
  });

  it("drops the oldest diagnostics once the capacity of 50 is exceeded", async () => {
    const manager = new DesktopManager();
    for (let index = 1; index <= 51; index += 1) {
      await manager.showNotification({ title: `n${index}` });
    }
    const diagnostics = manager.getNotificationDiagnostics();
    expect(diagnostics).toHaveLength(50);
    expect(diagnostics[0]?.id).toBe("notification_2");
    expect(diagnostics.at(-1)?.id).toBe("notification_51");
  });

  it("returns null or false from window callbacks when none are registered", async () => {
    const manager = new DesktopManager();
    expect(() => manager.openSettings("general")).not.toThrow();
    expect(await manager.openSurfaceWindow("chat")).toBeNull();
    expect(
      await manager.openAppWindow({ title: "App", path: "/app" }),
    ).toBeNull();
    expect(manager.setManagedWindowAlwaysOnTop("win", true)).toBe(false);
  });

  it("auto-confirms message boxes from the desktop test env flags", async () => {
    const manager = new DesktopManager();
    process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS = "1";
    await expect(
      manager.showMessageBox({
        message: "Reset?",
        defaultId: 1,
      }),
    ).resolves.toEqual({ response: 1 });
    expect(electrobunMock.Utils.showMessageBox).not.toHaveBeenCalled();

    delete process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS;
    process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_RESET = "1";
    await expect(
      manager.showMessageBox({ message: "Reset?" }),
    ).resolves.toEqual({ response: 0 });
  });

  it("treats empty and blank open-dialog results as canceled", async () => {
    const manager = new DesktopManager();
    electrobunMock.Utils.openFileDialog.mockResolvedValueOnce([]);
    await expect(manager.showOpenDialog({})).resolves.toEqual({
      canceled: true,
      filePaths: [],
    });
    electrobunMock.Utils.openFileDialog.mockResolvedValueOnce([""]);
    await expect(manager.showSaveDialog({})).resolves.toEqual({
      canceled: true,
      filePaths: [],
    });
    electrobunMock.Utils.openFileDialog.mockResolvedValueOnce(["/tmp/file"]);
    await expect(manager.showOpenDialog({})).resolves.toEqual({
      canceled: false,
      filePaths: ["/tmp/file"],
    });
  });

  it("returns a canceled workspace pick without writing config", async () => {
    const { writeWorkspaceFolderConfig } = await import("@elizaos/core");
    const manager = new DesktopManager();
    electrobunMock.Utils.openFileDialog.mockResolvedValueOnce([]);
    await expect(manager.pickWorkspaceFolder({})).resolves.toEqual({
      canceled: true,
      path: "",
      bookmark: null,
    });
    expect(writeWorkspaceFolderConfig).not.toHaveBeenCalled();
  });
});

describe("DesktopManager version, packaging, display, and idle surfaces", () => {
  const originalPlatform = process.platform;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalElectrobunDev = process.env.ELECTROBUN_DEV;

  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalElectrobunDev === undefined) {
      delete process.env.ELECTROBUN_DEV;
    } else {
      process.env.ELECTROBUN_DEV = originalElectrobunDev;
    }
    resetDesktopManagerForTesting();
  });

  it("reads the updater version and falls back to 0.0.0 when it throws", async () => {
    vi.stubGlobal("Bun", { version: "1.3.14-test" });
    const manager = new DesktopManager();
    await expect(manager.getVersion()).resolves.toEqual({
      version: "1.2.3",
      name: getBrandConfig().appName,
      runtime: "electrobun/1.3.14-test",
    });
    electrobunMock.Updater.localInfo.version.mockRejectedValueOnce(
      new Error("updater unavailable"),
    );
    await expect(manager.getVersion()).resolves.toEqual({
      version: "0.0.0",
      name: getBrandConfig().appName,
      runtime: "electrobun/1.3.14-test",
    });
    vi.unstubAllGlobals();
  });

  it("treats ELECTROBUN_DEV as unpackaged unless NODE_ENV is production", async () => {
    const manager = new DesktopManager();
    process.env.ELECTROBUN_DEV = "1";
    delete process.env.NODE_ENV;
    await expect(manager.isPackaged()).resolves.toEqual({ packaged: false });
    process.env.NODE_ENV = "production";
    await expect(manager.isPackaged()).resolves.toEqual({ packaged: true });
    delete process.env.ELECTROBUN_DEV;
    delete process.env.NODE_ENV;
    await expect(manager.isPackaged()).resolves.toEqual({ packaged: true });
  });

  it("maps Screen APIs and reports a closed tray popover with no window", async () => {
    const manager = new DesktopManager();
    const visited: unknown[] = [];
    manager.forEachTrayPopoverWindow((window) => {
      visited.push(window);
    });
    expect(visited).toEqual([]);
    expect(manager.isTrayPopoverOpen()).toBe(false);
    expect(manager.getTrayPopoverDiagnostics()).toEqual({
      configured: false,
      windowPresent: false,
      visible: false,
      lastAnchorBounds: null,
    });
    expect(manager.hasVisibleTrayStatusItem()).toBe(false);
    await manager.toggleTrayPopover();
    manager.hideTrayPopover();
    manager.closeTrayPopover();
    await expect(manager.getCursorPosition()).resolves.toEqual({
      x: 12,
      y: 34,
    });
    await expect(manager.getAllDisplays()).resolves.toEqual({ displays: [] });
    await expect(manager.getPrimaryDisplay()).resolves.toEqual({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      scaleFactor: 2,
      isPrimary: true,
    });
  });

  it("leaves setOpacity a no-op and reports dock visibility without a darwin call", async () => {
    setPlatform("linux");
    const manager = new DesktopManager();
    await expect(manager.setOpacity({ opacity: 0.4 })).resolves.toBeUndefined();
    await expect(manager.getDockIconVisibility()).resolves.toEqual({
      visible: true,
    });
    expect(electrobunMock.Utils.isDockIconVisible).not.toHaveBeenCalled();
    await manager.setDockIconVisibility({ visible: false });
    expect(electrobunMock.Utils.setDockIconVisible).not.toHaveBeenCalled();
  });

  it("prefers CEF on linux when the renderer is available", async () => {
    setPlatform("linux");
    electrobunMock.BuildConfig.get.mockResolvedValueOnce({
      defaultRenderer: "native",
      availableRenderers: ["native", "cef"],
      cefVersion: "cef-test",
      bunVersion: "bun-test",
      runtime: "test",
    });
    const status = await new DesktopManager().getWebGpuBrowserStatus();
    expect(status.renderer).toBe("cef");
    expect(status.reason).toContain("CEF");
  });

  it("reports fn-hold as unavailable off macOS", async () => {
    setPlatform("linux");
    await expect(new DesktopManager().startFnHoldMonitor()).resolves.toEqual({
      status: "unavailable",
      fnSystemUsageType: 0,
    });
  });

  it("resolves a non-darwin workspace bookmark as ok with an empty path", () => {
    setPlatform("linux");
    expect(
      new DesktopManager().resolveWorkspaceFolderBookmark({
        bookmark: "unused",
      }),
    ).toEqual({ ok: true, path: "" });
  });

  it("reports auto-launch disabled when no platform autostart file exists", async () => {
    setPlatform("linux");
    await expect(new DesktopManager().getAutoLaunchStatus()).resolves.toEqual({
      enabled: false,
      openAsHidden: false,
    });
  });

  it("no-ops tray menu updates when no tray has been created", async () => {
    const manager = new DesktopManager();
    await manager.updateTray({ title: "Eliza" });
    manager.setTrayMenu({
      menu: [{ id: "quit", label: "Quit" }],
    });
    await manager.destroyTray();
  });
});
