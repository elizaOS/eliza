import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/helpers.js", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("../platform/helpers.js");
  return {
    ...mod,
    commandExists: vi.fn(() => true),
    currentPlatform: vi.fn(() => "darwin"),
  };
});

vi.mock("../platform/screenshot.js", () => ({
  captureScreenshot: vi.fn(() => Buffer.from("fake-png")),
}));

vi.mock("../platform/desktop.js", () => ({
  desktopClick: vi.fn(),
  desktopClickWithModifiers: vi.fn(),
  desktopDoubleClick: vi.fn(),
  desktopDrag: vi.fn(),
  desktopKeyCombo: vi.fn(),
  desktopKeyPress: vi.fn(),
  desktopMouseMove: vi.fn(),
  desktopRightClick: vi.fn(),
  desktopScroll: vi.fn(),
  desktopType: vi.fn(),
}));

vi.mock("../platform/windows-list.js", () => ({
  closeWindow: vi.fn(),
  focusWindow: vi.fn(),
  getScreenSize: vi.fn(() => ({ width: 1440, height: 900 })),
  listWindows: vi.fn(() => []),
  maximizeWindow: vi.fn(),
  minimizeWindow: vi.fn(),
}));

vi.mock("../platform/browser.js", () => ({
  clickBrowser: vi.fn(),
  closeBrowser: vi.fn(async () => {}),
  executeBrowser: vi.fn(),
  getBrowserClickables: vi.fn(async () => []),
  getBrowserContext: vi.fn(async () => ({
    isOpen: true,
    is_open: true,
    title: "Blank",
    url: "about:blank",
  })),
  getBrowserDom: vi.fn(async () => "<html></html>"),
  getBrowserInfo: vi.fn(async () => ({
    success: true,
    isOpen: true,
    is_open: true,
    title: "Blank",
    url: "about:blank",
  })),
  getBrowserState: vi.fn(async () => ({
    isOpen: true,
    is_open: true,
    title: "Blank",
    url: "about:blank",
  })),
  isBrowserAvailable: vi.fn(() => true),
  listBrowserTabs: vi.fn(async () => []),
  navigateBrowser: vi.fn(async () => ({
    isOpen: true,
    is_open: true,
    title: "Blank",
    url: "about:blank",
  })),
  openBrowser: vi.fn(async () => ({
    isOpen: true,
    is_open: true,
    title: "Blank",
    url: "about:blank",
  })),
  openBrowserTab: vi.fn(async () => ({
    active: true,
    id: "tab-1",
    title: "Blank",
    url: "about:blank",
  })),
  closeBrowserTab: vi.fn(async () => {}),
  screenshotBrowser: vi.fn(async () =>
    Buffer.from("fake-browser").toString("base64"),
  ),
  scrollBrowser: vi.fn(async () => {}),
  setBrowserRuntimeOptions: vi.fn(),
  switchBrowserTab: vi.fn(async () => ({
    isOpen: true,
    is_open: true,
    title: "Blank",
    url: "about:blank",
  })),
  typeBrowser: vi.fn(async () => {}),
  waitBrowser: vi.fn(async () => {}),
}));

describe("ComputerUseService approval flow", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("waits for approval before running a pending action", async () => {
    const { ComputerUseService } = await import(
      "../services/computer-use-service.ts"
    );

    const service = (await ComputerUseService.start({
      getSetting(key: string) {
        if (key === "COMPUTER_USE_APPROVAL_MODE") return "approve_all";
        if (key === "COMPUTER_USE_SCREENSHOT_AFTER_ACTION") return "false";
        return undefined;
      },
    } as never)) as ComputerUseService;

    const pendingExecution = service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [10, 20],
    });
    await Promise.resolve();

    const snapshot = service.getApprovalSnapshot();
    expect(snapshot.mode).toBe("approve_all");
    expect(snapshot.pendingCount).toBe(1);
    expect(snapshot.pendingApprovals[0]?.command).toBe("mouse_move");

    const resolution = service.resolveApproval(
      snapshot.pendingApprovals[0]!.id,
      true,
    );
    expect(resolution?.approved).toBe(true);

    await expect(pendingExecution).resolves.toEqual({ success: true });

    await service.stop();
  });

  it("returns a rejection result when approval is denied", async () => {
    const { ComputerUseService } = await import(
      "../services/computer-use-service.ts"
    );

    const service = (await ComputerUseService.start({
      getSetting(key: string) {
        if (key === "COMPUTER_USE_APPROVAL_MODE") return "approve_all";
        if (key === "COMPUTER_USE_SCREENSHOT_AFTER_ACTION") return "false";
        return undefined;
      },
    } as never)) as ComputerUseService;

    const pendingExecution = service.executeDesktopAction({
      action: "mouse_move",
      coordinate: [10, 20],
    });
    await Promise.resolve();

    const snapshot = service.getApprovalSnapshot();
    const resolution = service.resolveApproval(
      snapshot.pendingApprovals[0]!.id,
      false,
      "too risky",
    );
    expect(resolution?.approved).toBe(false);

    await expect(pendingExecution).resolves.toEqual({
      success: false,
      error: "Computer-use approval rejected: too risky",
    });

    await service.stop();
  });
});
