import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWindow: vi.fn(),
  getPrimaryDisplay: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("electrobun/bun", () => ({
  BrowserWindow: class BrowserWindow {},
  Screen: {
    getPrimaryDisplay: mocks.getPrimaryDisplay,
  },
}));

vi.mock("./electrobun-window-options", () => ({
  createElectrobunBrowserWindow: mocks.createWindow,
}));

vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: mocks.info,
    success: vi.fn(),
    warn: mocks.warn,
  },
}));

describe("pill window", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createWindow.mockReset();
    mocks.getPrimaryDisplay.mockReset();
    mocks.info.mockReset();
    mocks.warn.mockReset();
  });

  it("loads the OS pill into the live chat overlay shell route", async () => {
    const { buildPillRendererUrl } = await import("./pill-window");

    expect(buildPillRendererUrl("http://127.0.0.1:5174/home?old=1#hash")).toBe(
      "http://127.0.0.1:5174/home?shellMode=chat-overlay",
    );
  });

  it("creates a bottom-centered transparent always-on-top window", async () => {
    const closeHandlers: Array<() => void> = [];
    const setAlwaysOnTop = vi.fn();
    const windowMock = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "close") closeHandlers.push(handler);
      }),
      setAlwaysOnTop,
    };
    mocks.createWindow.mockReturnValue(windowMock);
    mocks.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 100, y: 50, width: 1600, height: 900 },
    });

    const { createPillWindow, getPillWindow } = await import("./pill-window");
    const win = createPillWindow({
      rendererUrl: "http://127.0.0.1:5174/",
      preload: "preload.js",
    });

    expect(win).toBe(windowMock);
    expect(mocks.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Eliza Pill",
        url: "http://127.0.0.1:5174/?shellMode=chat-overlay",
        preload: "preload.js",
        titleBarStyle: "hidden",
        transparent: true,
        activate: false,
        frame: {
          x: 720,
          y: 654,
          width: 360,
          height: 280,
        },
      }),
    );
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(getPillWindow()).toBe(windowMock);

    closeHandlers.forEach((handler) => handler());
    expect(getPillWindow()).toBeNull();
  });
});
