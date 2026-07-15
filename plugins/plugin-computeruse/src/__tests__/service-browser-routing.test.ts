/**
 * Browser command dispatch of ComputerUseService, driven against a mocked
 * platform/browser module (deterministic, no real CDP/Chromium — a headless CI
 * runner has no browser to launch). Mirrors browser-auto-open.test.ts: only the
 * CDP boundary is mocked; the service's routing, approval-command lookup, verb
 * dispatch, and normalization run for real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
    getBrowserInfo: vi.fn(async () => ({ success: true, ...state() })),
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
  } as unknown as IAgentRuntime;
}

const approvalConfigPath = path.join(
  os.homedir(),
  ".eliza",
  "computer-use-approval.json",
);

describe("ComputerUseService browser command dispatch", () => {
  let service: InstanceType<typeof ComputerUseService>;
  let savedApprovalConfig: string | null;

  beforeAll(async () => {
    savedApprovalConfig = readApprovalConfig();
    service = (await ComputerUseService.start(createRuntime())) as InstanceType<
      typeof ComputerUseService
    >;
  });

  afterAll(async () => {
    await service.stop();
    restoreApprovalConfig(savedApprovalConfig);
  });

  it("dispatches every browser verb through executeBrowserAction", async () => {
    const params: Array<Record<string, unknown> & { action: string }> = [
      { action: "open", url: "https://example.com" },
      { action: "connect" },
      { action: "navigate", url: "https://example.com" },
      { action: "state" },
      { action: "info" },
      { action: "context" },
      { action: "get_context" },
      { action: "dom" },
      { action: "get_dom" },
      { action: "clickables" },
      { action: "get_clickables" },
      { action: "click", coordinate: [10, 10] },
      { action: "type", text: "hello" },
      { action: "scroll", coordinate: [10, 10] },
      { action: "screenshot" },
      { action: "wait" },
      { action: "list_tabs" },
      { action: "open_tab", url: "https://example.com" },
      { action: "switch_tab", tabId: "1" },
      { action: "close_tab", tabId: "1" },
      { action: "execute", script: "1+1" },
      { action: "close" },
    ];
    for (const param of params) {
      const result = await service.executeBrowserAction(
        param as Parameters<
          InstanceType<typeof ComputerUseService>["executeBrowserAction"]
        >[0],
      );
      expect(typeof result.success).toBe("boolean");
    }
  }, 20_000);

  it("keeps browser_execute disabled regardless of approval mode", async () => {
    const result = await service.executeBrowserAction({
      action: "execute",
      script: "alert(1)",
    } as Parameters<
      InstanceType<typeof ComputerUseService>["executeBrowserAction"]
    >[0]);
    expect(result.success).toBe(false);
  });

  it("routes browser command strings through executeCommand", async () => {
    for (const command of [
      "browser_open",
      "browser_navigate",
      "browser_state",
      "browser_info",
      "browser_get_dom",
      "browser_get_clickables",
      "browser_screenshot",
      "browser_list_tabs",
      "browser_open_tab",
      "browser_switch_tab",
      "browser_close_tab",
      "browser_close",
    ]) {
      const result = await service.executeCommand(command, {
        url: "https://example.com",
        tabId: "1",
      });
      expect(typeof result.success).toBe("boolean");
    }
  }, 20_000);
});

function readApprovalConfig(): string | null {
  try {
    return fs.readFileSync(approvalConfigPath, "utf8");
  } catch (err) {
    // error-policy:J3 a missing file is the expected CI/first-run shape; any
    // other read error means restore is unsafe, so surface it.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

function restoreApprovalConfig(saved: string | null): void {
  if (saved === null) {
    fs.rmSync(approvalConfigPath, { force: true });
    return;
  }
  fs.writeFileSync(approvalConfigPath, saved, "utf8");
}
