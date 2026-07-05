/** Exercises desktop window behavior with deterministic app-core test fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopManager, resetDesktopManagerForTesting } from "./desktop";

vi.mock("@elizaos/core", () => ({
  clearWorkspaceFolderConfig: vi.fn(),
  formatError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  writeWorkspaceFolderConfig: vi.fn(),
}));

vi.mock("./mac-window-effects", () => ({
  enableVibrancy: vi.fn(() => false),
  ensureShadow: vi.fn(() => false),
  setNativeDragRegion: vi.fn(),
  setTrafficLightsPosition: vi.fn(),
}));

const electrobunMock = vi.hoisted(() => {
  type Handler = (event?: unknown) => void;
  const handlers = new Map<string, Handler[]>();
  type MockBrowserWindow = {
    id: number;
    frame: { x: number; y: number; width: number; height: number };
    options: Record<string, unknown>;
    webview: {
      on: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    setAlwaysOnTop: ReturnType<typeof vi.fn>;
    emit: (event: string) => void;
    emitWebview: (event: string) => void;
  };
  let nextBrowserWindowId = 1;
  const browserWindowInstances: MockBrowserWindow[] = [];
  const trayInstances: Array<{
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    setImage: ReturnType<typeof vi.fn>;
    setMenu: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
  }> = [];
  const events = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((item) => item !== handler),
      );
    }),
    emit(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
  const BrowserWindow = vi.fn(function FakeNativeBrowserWindow(
    this: MockBrowserWindow,
    options: Record<string, unknown>,
  ) {
    const windowHandlers = new Map<string, Array<() => void>>();
    const webviewHandlers = new Map<string, Array<() => void>>();
    this.id = nextBrowserWindowId++;
    this.options = options;
    this.frame = (options.frame as MockBrowserWindow["frame"] | undefined) ?? {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    };
    this.webview = {
      on: vi.fn((event: string, handler: () => void) => {
        const list = webviewHandlers.get(event) ?? [];
        list.push(handler);
        webviewHandlers.set(event, list);
      }),
      remove: vi.fn(),
    };
    this.on = vi.fn((event: string, handler: () => void) => {
      const list = windowHandlers.get(event) ?? [];
      list.push(handler);
      windowHandlers.set(event, list);
    });
    this.close = vi.fn(() => {
      for (const handler of windowHandlers.get("close") ?? []) {
        handler();
      }
    });
    this.focus = vi.fn();
    this.setAlwaysOnTop = vi.fn();
    this.emit = (event: string) => {
      for (const handler of windowHandlers.get(event) ?? []) {
        handler();
      }
    };
    this.emitWebview = (event: string) => {
      for (const handler of webviewHandlers.get(event) ?? []) {
        handler();
      }
    };
    browserWindowInstances.push(this);
  });
  const Tray = vi.fn(function FakeTray(this: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    setImage: ReturnType<typeof vi.fn>;
    setMenu: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
  }) {
    this.on = vi.fn();
    this.off = vi.fn();
    this.remove = vi.fn();
    this.setImage = vi.fn();
    this.setMenu = vi.fn();
    this.setTitle = vi.fn();
    trayInstances.push(this);
  });
  const Utils = {
    clipboard: {},
    openExternal: vi.fn(),
    paths: {
      home: "/tmp",
      appData: "/tmp",
      userData: "/tmp",
      userCache: "/tmp",
      userLogs: "/tmp",
      temp: "/tmp",
      cache: "/tmp",
      logs: "/tmp",
      config: "/tmp",
      documents: "/tmp",
      downloads: "/tmp",
      desktop: "/tmp",
      pictures: "/tmp",
      music: "/tmp",
      videos: "/tmp",
    },
    quit: vi.fn(),
    showNotification: vi.fn(),
    showItemInFolder: vi.fn(),
    setDockIconVisible: vi.fn(),
    isDockIconVisible: vi.fn(() => true),
  };
  const GlobalShortcut = {
    isRegistered: vi.fn(() => false),
    register: vi.fn(),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  };
  return {
    events,
    handlers,
    browserWindowInstances,
    trayInstances,
    BrowserWindow,
    GlobalShortcut,
    Tray,
    Utils,
    reset() {
      handlers.clear();
      nextBrowserWindowId = 1;
      browserWindowInstances.splice(0);
      trayInstances.splice(0);
      BrowserWindow.mockClear();
      events.on.mockClear();
      events.off.mockClear();
      GlobalShortcut.isRegistered.mockClear();
      GlobalShortcut.register.mockClear();
      GlobalShortcut.unregister.mockClear();
      GlobalShortcut.unregisterAll.mockClear();
      Tray.mockClear();
      for (const value of Object.values(Utils)) {
        if (typeof value === "function" && "mockClear" in value) {
          value.mockClear();
        }
      }
    },
  };
});

vi.mock("electrobun/bun", () => {
  return {
    default: {
      events: electrobunMock.events,
      BrowserWindow: electrobunMock.BrowserWindow,
    },
    BrowserWindow: electrobunMock.BrowserWindow,
    BrowserView: vi.fn(),
    BuildConfig: {
      appIdentifier: "test.eliza",
      appVersion: "0.0.0-test",
      get: vi.fn(async () => ({
        defaultRenderer: "native",
        availableRenderers: ["native"],
        cefVersion: "cef-test",
        bunVersion: "bun-test",
        runtime: "test",
      })),
    },
    ContextMenu: {
      on: vi.fn(),
    },
    GlobalShortcut: electrobunMock.GlobalShortcut,
    Screen: {
      getAllDisplays: vi.fn(() => []),
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 100, y: 50, width: 900, height: 700 },
      })),
    },
    Session: {
      defaultSession: {},
    },
    Tray: electrobunMock.Tray,
    Updater: {},
    Utils: electrobunMock.Utils,
  };
});

class FakeBrowserWindow {
  readonly handlers = new Map<string, Array<() => void>>();
  readonly off = vi.fn((event: string, handler: () => void) => {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((item) => item !== handler),
    );
  });
  readonly on = vi.fn((event: string, handler: () => void) => {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  });
  readonly show = vi.fn();
  readonly focus = vi.fn();
  readonly close = vi.fn();
  readonly minimize = vi.fn(() => {
    this.minimized = true;
  });
  readonly unminimize = vi.fn(() => {
    this.minimized = false;
  });
  readonly maximize = vi.fn(() => {
    this.maximized = true;
  });
  readonly unmaximize = vi.fn(() => {
    this.maximized = false;
  });
  readonly setAlwaysOnTop = vi.fn();
  readonly setFullScreen = vi.fn();
  readonly setTitle = vi.fn();
  readonly setPosition = vi.fn((x: number, y: number) => {
    this.position = { x, y };
  });
  readonly setSize = vi.fn((width: number, height: number) => {
    this.size = { width, height };
  });
  position = { x: 10, y: 20 };
  size = { width: 800, height: 600 };
  minimized = false;
  maximized = false;

  getPosition() {
    return this.position;
  }

  getSize() {
    return this.size;
  }

  isMinimized() {
    return this.minimized;
  }

  isMaximized() {
    return this.maximized;
  }

  emit(event: string) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler();
    }
  }
}

function createManagerWithWindow() {
  const manager = new DesktopManager();
  const window = new FakeBrowserWindow();
  manager.setMainWindow(window as never);
  return { manager, window };
}

describe("DesktopManager main window controls", () => {
  const originalCloseMinimizes = process.env.ELIZAOS_CLOSE_MINIMIZES_TO_TRAY;

  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
    delete process.env.ELIZAOS_CLOSE_MINIMIZES_TO_TRAY;
  });

  afterEach(() => {
    resetDesktopManagerForTesting();
    if (originalCloseMinimizes === undefined) {
      delete process.env.ELIZAOS_CLOSE_MINIMIZES_TO_TRAY;
    } else {
      process.env.ELIZAOS_CLOSE_MINIMIZES_TO_TRAY = originalCloseMinimizes;
    }
  });

  it("applies partial window options against current position and size", async () => {
    const { manager, window } = createManagerWithWindow();

    await manager.setWindowOptions({
      width: 1024,
      y: 44,
      alwaysOnTop: true,
      fullscreen: true,
      opacity: 0.5,
      title: "Window Manager",
    });

    expect(window.setSize).toHaveBeenCalledWith(1024, 600);
    expect(window.setPosition).toHaveBeenCalledWith(10, 44);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(window.setFullScreen).toHaveBeenCalledWith(true);
    expect(window.setTitle).toHaveBeenCalledWith("Window Manager");
  });

  it("gets and sets full window bounds", async () => {
    const { manager, window } = createManagerWithWindow();

    await expect(manager.getWindowBounds()).resolves.toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });

    await manager.setWindowBounds({ x: 30, y: 40, width: 900, height: 700 });

    expect(window.setPosition).toHaveBeenCalledWith(30, 40);
    expect(window.setSize).toHaveBeenCalledWith(900, 700);
    await expect(manager.getWindowBounds()).resolves.toEqual({
      x: 30,
      y: 40,
      width: 900,
      height: 700,
    });
  });

  it("returns safe fallback states when no main window is present", async () => {
    const manager = new DesktopManager();

    await expect(manager.getWindowBounds()).resolves.toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    await expect(manager.isWindowVisible()).resolves.toEqual({
      visible: false,
    });
    await expect(manager.isWindowMaximized()).resolves.toEqual({
      maximized: false,
    });
    await expect(manager.isWindowMinimized()).resolves.toEqual({
      minimized: false,
    });
    await expect(manager.setWindowOptions({ width: 100 })).resolves.toBe(
      undefined,
    );
    await expect(
      manager.setWindowBounds({ x: 1, y: 2, width: 3, height: 4 }),
    ).resolves.toBe(undefined);
    await expect(manager.focusWindow()).resolves.toBe(undefined);
  });

  it("minimizes, restores, maximizes, unmaximizes, focuses, and reports state", async () => {
    const { manager, window } = createManagerWithWindow();

    await manager.minimizeWindow();
    await expect(manager.isWindowMinimized()).resolves.toEqual({
      minimized: true,
    });
    await expect(manager.isWindowVisible()).resolves.toEqual({
      visible: false,
    });

    await manager.unminimizeWindow();
    await manager.maximizeWindow();
    await expect(manager.isWindowMaximized()).resolves.toEqual({
      maximized: true,
    });

    await manager.unmaximizeWindow();
    await manager.focusWindow();

    expect(window.unminimize).toHaveBeenCalledTimes(1);
    expect(window.maximize).toHaveBeenCalledTimes(1);
    expect(window.unmaximize).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("tracks focus and blur events through webview notifications", async () => {
    const sendToWebview = vi.fn();
    const { manager, window } = createManagerWithWindow();
    manager.setSendToWebview(sendToWebview);

    window.emit("blur");
    await expect(manager.isWindowFocused()).resolves.toEqual({
      focused: false,
    });
    expect(sendToWebview).toHaveBeenCalledWith("desktopWindowBlur", undefined);

    window.emit("focus");
    await expect(manager.isWindowFocused()).resolves.toEqual({
      focused: true,
    });
    expect(sendToWebview).toHaveBeenCalledWith("desktopWindowFocus", undefined);
  });

  it("hides on close by default and hard-closes when tray-minimize is disabled", async () => {
    const { manager, window } = createManagerWithWindow();

    await manager.closeWindow();
    expect(window.minimize).toHaveBeenCalledTimes(1);
    expect(window.close).not.toHaveBeenCalled();
    await expect(manager.isWindowVisible()).resolves.toEqual({
      visible: false,
    });

    process.env.ELIZAOS_CLOSE_MINIMIZES_TO_TRAY = "0";
    await manager.closeWindow();
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it("restores a missing main window before showing it", async () => {
    const manager = new DesktopManager();
    const restored = new FakeBrowserWindow();
    const restore = vi.fn(() => {
      manager.setMainWindow(restored as never);
    });
    manager.setRestoreMainWindowCallback(restore);

    await manager.showWindow();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restored.show).toHaveBeenCalledTimes(1);
    expect(restored.focus).toHaveBeenCalledTimes(1);
    await expect(manager.isWindowVisible()).resolves.toEqual({
      visible: true,
    });
  });

  it("tears down old window event handlers when replacing the main window", () => {
    const manager = new DesktopManager();
    const first = new FakeBrowserWindow();
    const second = new FakeBrowserWindow();

    manager.setMainWindow(first as never);
    manager.setMainWindow(second as never);

    expect(first.off).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(first.off).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(first.off).toHaveBeenCalledWith("close", expect.any(Function));
    expect(first.off).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(first.off).toHaveBeenCalledWith("move", expect.any(Function));
    expect(second.on).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(second.on).toHaveBeenCalledWith("blur", expect.any(Function));
  });

  it("routes tray quit through the app quit callback", async () => {
    const manager = new DesktopManager();
    const requestQuit = vi.fn(async () => {});
    manager.setRequestQuitCallback(requestQuit);

    await manager.createTray({
      icon: "/tmp/appIcon.png",
      menu: [{ id: "quit", label: "Quit" }],
    });

    electrobunMock.events.emit("tray-clicked", {
      data: { action: "quit" },
    });

    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledTimes(1));
    expect(electrobunMock.Utils.quit).not.toHaveBeenCalled();
  });

  it("reports global shortcut registration rejection without tracking the shortcut", async () => {
    const manager = new DesktopManager();
    electrobunMock.GlobalShortcut.register.mockReturnValueOnce(false);

    await expect(
      manager.registerShortcut({
        id: "chat-overlay",
        accelerator: "CommandOrControl+Shift+C",
      }),
    ).resolves.toEqual({ success: false });

    await manager.unregisterShortcut({ id: "chat-overlay" });

    expect(electrobunMock.GlobalShortcut.register).toHaveBeenCalledWith(
      "CommandOrControl+Shift+C",
      expect.any(Function),
    );
    expect(electrobunMock.GlobalShortcut.unregister).not.toHaveBeenCalled();
  });

  it("tracks successfully registered global shortcuts for replacement and unregister", async () => {
    const manager = new DesktopManager();
    electrobunMock.GlobalShortcut.register
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    await expect(
      manager.registerShortcut({
        id: "chat-overlay",
        accelerator: "CommandOrControl+Shift+C",
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      manager.registerShortcut({
        id: "chat-overlay",
        accelerator: "CommandOrControl+J",
      }),
    ).resolves.toEqual({ success: true });
    await manager.unregisterShortcut({ id: "chat-overlay" });

    expect(electrobunMock.GlobalShortcut.unregister).toHaveBeenCalledWith(
      "CommandOrControl+Shift+C",
    );
    expect(electrobunMock.GlobalShortcut.unregister).toHaveBeenCalledWith(
      "CommandOrControl+J",
    );
  });

  it("opens tray popover as an app renderer with preload, rpc, partition, and API injection", async () => {
    const manager = new DesktopManager();
    const rpc = { request: {}, send: {}, setTransport: vi.fn() };
    const injectApiBase = vi.fn();
    const wireRpc = vi.fn();
    const onWindowFocused = vi.fn();

    manager.configureTrayPopover({
      url: "http://127.0.0.1:5173/?shellMode=tray-popover",
      preload: "// preload",
      partition: "persist:eliza-main",
      rpc,
      injectApiBase,
      wireRpc,
      onWindowFocused,
    });

    await manager.toggleTrayPopover();

    const win = electrobunMock.browserWindowInstances[0];
    expect(electrobunMock.BrowserWindow).toHaveBeenCalledTimes(1);
    expect(win.options).toMatchObject({
      url: "http://127.0.0.1:5173/?shellMode=tray-popover",
      preload: "// preload",
      partition: "persist:eliza-main",
      rpc,
      renderer: "native",
      transparent: true,
      titleBarStyle: "hidden",
    });
    expect(win.frame).toEqual({
      x: 100 + 900 - 360 - 8,
      y: 50 + 8,
      width: 360,
      height: 480,
    });
    expect(win.webview.remove).not.toHaveBeenCalled();
    expect(wireRpc).toHaveBeenCalledWith(win);
    expect(onWindowFocused).toHaveBeenCalledWith(win);
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(win.focus).toHaveBeenCalledTimes(1);

    const seen: unknown[] = [];
    manager.forEachTrayPopoverWindow((window) => seen.push(window));
    expect(seen).toEqual([win]);

    win.emitWebview("dom-ready");
    expect(injectApiBase).toHaveBeenCalledWith(win);
  });

  it("awaits tray teardown during dispose", async () => {
    const manager = new DesktopManager();
    await manager.createTray({
      icon: "/tmp/appIcon.png",
      menu: [{ id: "quit", label: "Quit" }],
    });
    const tray = electrobunMock.trayInstances[0];

    await manager.dispose();

    expect(tray.off).toHaveBeenCalledWith("tray-clicked", expect.any(Function));
    expect(electrobunMock.events.off).toHaveBeenCalledWith(
      "tray-clicked",
      expect.any(Function),
    );
    expect(tray.remove).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopManager notifications", () => {
  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
  });

  afterEach(() => {
    resetDesktopManagerForTesting();
  });

  it("maps notification options to Utils.showNotification and returns monotonic ids", async () => {
    const manager = new DesktopManager();

    await expect(
      manager.showNotification({
        title: "Build finished",
        body: "Desktop build completed.",
        urgency: "critical",
        silent: false,
      }),
    ).resolves.toEqual({ id: "notification_1" });
    await expect(
      manager.showNotification({
        title: "Quiet sync",
        body: "Background sync completed.",
        urgency: "low",
        silent: true,
      }),
    ).resolves.toEqual({ id: "notification_2" });

    expect(electrobunMock.Utils.showNotification).toHaveBeenNthCalledWith(1, {
      title: "Build finished",
      body: "Desktop build completed.",
      subtitle: undefined,
      silent: false,
    });
    expect(electrobunMock.Utils.showNotification).toHaveBeenNthCalledWith(2, {
      title: "Quiet sync",
      body: "Background sync completed.",
      subtitle: undefined,
      silent: true,
    });
  });

  it("documents closeNotification as an Electrobun no-op", async () => {
    const manager = new DesktopManager();

    await expect(
      manager.closeNotification({ id: "notification_1" }),
    ).resolves.toBeUndefined();
    expect(electrobunMock.Utils.showNotification).not.toHaveBeenCalled();
  });
});

describe("DesktopManager dockless (tray-first) Dock tracking (#12184)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    resetDesktopManagerForTesting();
    electrobunMock.reset();
    // Dock control is macOS-only (setDockIconVisibility guards on darwin).
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  const dockCalls = (): boolean[] =>
    electrobunMock.Utils.setDockIconVisible.mock.calls.map(
      (call: unknown[]) => call[0] as boolean,
    );

  it("hides the Dock icon at rest — only the pill exists", () => {
    const manager = new DesktopManager();
    manager.setTrayFirstMode(true);
    // Pill main window is attached: NOT a full window → Dock stays hidden.
    manager.setMainWindowFullWindow(false);
    expect(dockCalls().at(-1)).toBe(false);
  });

  it("reveals the Dock icon when a managed window opens, hides it when the last closes", () => {
    const manager = new DesktopManager();
    manager.setTrayFirstMode(true);
    manager.setMainWindowFullWindow(false);

    manager.setManagedWindowsPresent(true);
    expect(dockCalls().at(-1)).toBe(true);

    manager.setManagedWindowsPresent(false);
    expect(dockCalls().at(-1)).toBe(false);
  });

  it("reveals the Dock icon when the main window itself is a full dashboard", () => {
    const manager = new DesktopManager();
    manager.setTrayFirstMode(true);
    manager.setMainWindowFullWindow(true);
    expect(dockCalls().at(-1)).toBe(true);
  });

  it("does not touch the Dock icon when dockless mode is off", () => {
    const manager = new DesktopManager();
    manager.setMainWindowFullWindow(true);
    manager.setManagedWindowsPresent(true);
    expect(electrobunMock.Utils.setDockIconVisible).not.toHaveBeenCalled();
  });
});
