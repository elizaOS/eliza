import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopManager, resetDesktopManagerForTesting } from "./desktop";

vi.mock("electrobun/bun", () => {
  return {
    default: {},
    BrowserView: vi.fn(),
    BuildConfig: {
      appIdentifier: "test.eliza",
      appVersion: "0.0.0-test",
    },
    ContextMenu: {
      on: vi.fn(),
    },
    GlobalShortcut: vi.fn(),
    Screen: {
      getAllDisplays: vi.fn(() => []),
    },
    Session: {
      defaultSession: {},
    },
    Tray: vi.fn(),
    Updater: {},
    Utils: {
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
      showNotification: vi.fn(),
      showItemInFolder: vi.fn(),
    },
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
});
