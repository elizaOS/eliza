import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/browser.js", () => {
  const state = (url = "about:blank") => ({
    url,
    title: "Example",
    isOpen: true,
    is_open: true,
  });

  return {
    clickBrowser: vi.fn(async () => {}),
    closeBrowser: vi.fn(async () => {}),
    closeBrowserTab: vi.fn(async () => {}),
    executeBrowser: vi.fn(async () => "ok"),
    getBrowserClickables: vi.fn(async () => []),
    getBrowserContext: vi.fn(async () => state()),
    getBrowserDom: vi.fn(async () => "<html></html>"),
    getBrowserInfo: vi.fn(async () => ({
      success: true,
      ...state(),
    })),
    getBrowserState: vi.fn(async () => state()),
    isBrowserAvailable: vi.fn(() => true),
    listBrowserTabs: vi.fn(async () => []),
    navigateBrowser: vi.fn(async (url: string) => state(url)),
    openBrowser: vi.fn(async (url?: string) => state(url)),
    openBrowserTab: vi.fn(async (url?: string) => ({
      id: "1",
      url: url ?? "about:blank",
      title: "Example",
      active: true,
    })),
    screenshotBrowser: vi.fn(async () => "base64"),
    scrollBrowser: vi.fn(async () => {}),
    setBrowserRuntimeOptions: vi.fn(),
    switchBrowserTab: vi.fn(async () => state()),
    typeBrowser: vi.fn(async () => {}),
    waitBrowser: vi.fn(async () => {}),
  };
});

const browser = await import("../platform/browser.js");
const { ComputerUseService } = await import(
  "../services/computer-use-service.js"
);

function createRuntime(): IAgentRuntime {
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

describe("ComputerUseService browser auto-open recovery", () => {
  let service: ComputerUseService;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(browser.openBrowser).mockImplementation(async (url?: string) => ({
      url: url ?? "about:blank",
      title: "Example",
      isOpen: true,
      is_open: true,
    }));
    vi.mocked(browser.navigateBrowser).mockImplementation(
      async (url: string) => ({
        url,
        title: "Example",
        isOpen: true,
        is_open: true,
      }),
    );
    vi.mocked(browser.getBrowserInfo).mockResolvedValue({
      success: true,
      url: "about:blank",
      title: "Example",
      isOpen: true,
      is_open: true,
    });
    service = (await ComputerUseService.start(
      createRuntime(),
    )) as ComputerUseService;
  });

  afterEach(async () => {
    await service.stop();
  });

  it("opens the browser and retries a first-call navigate failure once", async () => {
    vi.mocked(browser.navigateBrowser)
      .mockRejectedValueOnce(
        new Error("Browser not open. Use the open action first."),
      )
      .mockResolvedValueOnce({
        url: "https://example.com",
        title: "Example",
        isOpen: true,
        is_open: true,
      });

    const result = await service.executeBrowserAction({
      action: "navigate",
      url: "https://example.com",
    });

    expect(result).toMatchObject({
      success: true,
      url: "https://example.com",
    });
    expect(browser.openBrowser).toHaveBeenCalledTimes(1);
    expect(browser.openBrowser).toHaveBeenCalledWith("https://example.com");
    expect(browser.navigateBrowser).toHaveBeenCalledTimes(2);
  });

  it("also recovers when a non-lifecycle action returns a Browser not open result", async () => {
    vi.mocked(browser.getBrowserInfo)
      .mockResolvedValueOnce({
        success: false,
        url: "",
        title: "",
        isOpen: false,
        is_open: false,
        error: "Browser not open.",
      })
      .mockResolvedValueOnce({
        success: true,
        url: "about:blank",
        title: "Example",
        isOpen: true,
        is_open: true,
      });

    const result = await service.executeBrowserAction({ action: "info" });

    expect(result).toMatchObject({
      success: true,
      isOpen: true,
    });
    expect(browser.openBrowser).toHaveBeenCalledTimes(1);
    expect(browser.getBrowserInfo).toHaveBeenCalledTimes(2);
  });

  it("does not auto-open for lifecycle close failures", async () => {
    vi.mocked(browser.closeBrowser).mockRejectedValueOnce(
      new Error("Browser not open."),
    );

    const result = await service.executeBrowserAction({ action: "close" });

    expect(result).toMatchObject({
      success: false,
      error: "Browser not open.",
    });
    expect(browser.openBrowser).not.toHaveBeenCalled();
  });
});
