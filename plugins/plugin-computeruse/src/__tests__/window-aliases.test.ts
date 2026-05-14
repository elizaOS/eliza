import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformCapabilities, WindowInfo } from "../types.js";

const sampleWindow: WindowInfo = {
  id: "w1",
  app: "Notes",
  title: "Daily Notes",
  x: 10,
  y: 20,
  width: 800,
  height: 600,
  bounds: [10, 20, 800, 600],
};

const capabilities: PlatformCapabilities = {
  screenshot: { available: false, tool: "mock" },
  computerUse: { available: false, tool: "mock" },
  windowList: { available: true, tool: "mock" },
  browser: { available: false, tool: "mock" },
  terminal: { available: false, tool: "mock" },
  fileSystem: { available: false, tool: "mock" },
};

vi.mock("../platform/capabilities.js", () => ({
  detectPlatformCapabilities: () => capabilities,
}));

vi.mock("../scene/vision-ocr-provider.js", () => ({
  registerVisionOcrProvider: vi.fn(),
}));

vi.mock("../platform/browser.js", () => ({
  closeBrowser: vi.fn(async () => undefined),
  closeBrowserTab: vi.fn(),
  clickBrowser: vi.fn(),
  executeBrowser: vi.fn(),
  getBrowserClickables: vi.fn(),
  getBrowserContext: vi.fn(),
  getBrowserDom: vi.fn(),
  getBrowserInfo: vi.fn(),
  getBrowserState: vi.fn(),
  isBrowserAvailable: vi.fn(() => false),
  listBrowserTabs: vi.fn(),
  navigateBrowser: vi.fn(),
  openBrowser: vi.fn(),
  openBrowserTab: vi.fn(),
  screenshotBrowser: vi.fn(),
  scrollBrowser: vi.fn(),
  setBrowserRuntimeOptions: vi.fn(),
  switchBrowserTab: vi.fn(),
  typeBrowser: vi.fn(),
  waitBrowser: vi.fn(),
}));

vi.mock("../platform/windows-list.js", () => ({
  arrangeWindows: vi.fn(() => ({ success: true, message: "arranged" })),
  closeWindow: vi.fn(),
  focusWindow: vi.fn(),
  getApplicationWindows: vi.fn(() => [sampleWindow]),
  getCurrentWindow: vi.fn(() => sampleWindow),
  getCurrentWindowId: vi.fn(() => sampleWindow.id),
  getScreenSize: vi.fn(() => ({ width: 1920, height: 1080 })),
  getWindowName: vi.fn(() => sampleWindow.title),
  getWindowPosition: vi.fn(() => ({ x: sampleWindow.x, y: sampleWindow.y })),
  getWindowSize: vi.fn(() => ({
    width: sampleWindow.width,
    height: sampleWindow.height,
  })),
  launchApplication: vi.fn(() => ({ success: true, message: "launched" })),
  listWindows: vi.fn(() => [sampleWindow]),
  maximizeWindow: vi.fn(),
  minimizeWindow: vi.fn(),
  moveWindow: vi.fn(() => ({ success: true, message: "moved" })),
  openWindow: vi.fn(() => ({ success: true, message: "opened" })),
  restoreWindow: vi.fn(),
  setWindowPosition: vi.fn(() => ({ success: true, message: "positioned" })),
  setWindowSize: vi.fn(() => ({ success: true, message: "resized" })),
  switchWindow: vi.fn(),
}));

function createMockRuntime(): IAgentRuntime {
  return {
    character: {},
    getSetting(key: string) {
      return key === "COMPUTER_USE_APPROVAL_MODE" ? "full_control" : undefined;
    },
    getService() {
      return null;
    },
  } as IAgentRuntime;
}

describe("ComputerUseService window aliases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Cua-compatible getter results", async () => {
    const { ComputerUseService } = await import(
      "../services/computer-use-service.js"
    );
    const service = (await ComputerUseService.start(
      createMockRuntime(),
    )) as ComputerUseService;

    const current = await service.executeCommand("get_current_window_id");
    expect(current).toMatchObject({
      success: true,
      windowId: "w1",
      window_id: "w1",
    });

    const appWindows = await service.executeCommand("get_application_windows", {
      appName: "Notes",
    });
    expect(appWindows.success).toBe(true);
    expect(appWindows.windows).toEqual([sampleWindow]);

    const name = await service.executeWindowAction({
      action: "get_window_name",
      windowId: "w1",
    });
    expect(name).toMatchObject({ success: true, name: "Daily Notes" });

    const size = await service.executeCommand("get_window_size", {
      windowId: "w1",
    });
    expect(size).toMatchObject({ success: true, width: 800, height: 600 });

    const position = await service.executeCommand("get_window_position", {
      windowId: "w1",
    });
    expect(position).toMatchObject({ success: true, x: 10, y: 20 });
  });

  it("routes Cua-compatible open, launch, setter, and activation aliases", async () => {
    const windows = await import("../platform/windows-list.js");
    const { ComputerUseService } = await import(
      "../services/computer-use-service.js"
    );
    const service = (await ComputerUseService.start(
      createMockRuntime(),
    )) as ComputerUseService;

    await expect(
      service.executeCommand("open", { appName: "Notes" }),
    ).resolves.toMatchObject({ success: true });
    expect(windows.openWindow).toHaveBeenCalledWith("Notes");

    await expect(
      service.executeCommand("launch", { appName: "Notes" }),
    ).resolves.toMatchObject({ success: true });
    expect(windows.launchApplication).toHaveBeenCalledWith("Notes");

    await expect(
      service.executeCommand("set_window_size", {
        windowId: "w1",
        width: 640,
        height: 480,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(windows.setWindowSize).toHaveBeenCalledWith("w1", 640, 480);

    await expect(
      service.executeCommand("set_window_position", {
        windowId: "w1",
        x: 30,
        y: 40,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(windows.setWindowPosition).toHaveBeenCalledWith("w1", 30, 40);

    await expect(
      service.executeCommand("activate_window", { windowId: "w1" }),
    ).resolves.toMatchObject({ success: true });
    expect(windows.focusWindow).toHaveBeenCalledWith("w1");
  });
});
