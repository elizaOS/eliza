/**
 * Tests for action definitions — structure, validation, and handler behavior.
 *
 * Uses a mock runtime to test action validators and handlers without
 * actually performing desktop operations (those are covered in service tests).
 */
import { describe, expect, it, vi } from "vitest";
import { useComputerAction } from "../actions/use-computer.js";
import { takeScreenshotAction } from "../actions/take-screenshot.js";
import { browserAction } from "../actions/browser-action.js";
import { manageWindowAction } from "../actions/manage-window.js";
import type { IAgentRuntime, Memory } from "@elizaos/core";

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockRuntime(hasService = false, serviceOverride?: object): IAgentRuntime {
  return {
    character: {},
    getService(name: string) {
      if (!hasService) return null;
      if (serviceOverride) return serviceOverride;
      return {
        getCapabilities: () => ({
          screenshot: { available: true, tool: "test" },
          computerUse: { available: true, tool: "test" },
          windowList: { available: true, tool: "test" },
          browser: { available: true, tool: "test" },
        }),
      };
    },
  } as unknown as IAgentRuntime;
}

function createMockMessage(text = ""): Memory {
  return {
    content: { text },
    roomId: "test-room" as any,
    agentId: "test-agent" as any,
  } as Memory;
}

// ── USE_COMPUTER ────────────────────────────────────────────────────────

describe("USE_COMPUTER action", () => {
  it("has correct name and similes", () => {
    expect(useComputerAction.name).toBe("USE_COMPUTER");
    expect(Array.isArray(useComputerAction.similes)).toBe(true);
    expect(useComputerAction.similes!.length).toBeGreaterThan(0);
    expect(useComputerAction.similes).toContain("CONTROL_COMPUTER");
    expect(useComputerAction.similes).toContain("CLICK");
    expect(useComputerAction.similes).toContain("TYPE_TEXT");
    expect(useComputerAction.similes).toContain("PRESS_KEY");
    expect(useComputerAction.similes).toContain("SCROLL_SCREEN");
    expect(useComputerAction.similes).toContain("MOVE_MOUSE");
    expect(useComputerAction.similes).toContain("DRAG");
  });

  it("has a detailed description mentioning all action types", () => {
    expect(useComputerAction.description).toContain("screenshot");
    expect(useComputerAction.description).toContain("click");
    expect(useComputerAction.description).toContain("double_click");
    expect(useComputerAction.description).toContain("right_click");
    expect(useComputerAction.description).toContain("mouse_move");
    expect(useComputerAction.description).toContain("type");
    expect(useComputerAction.description).toContain("key");
    expect(useComputerAction.description).toContain("key_combo");
    expect(useComputerAction.description).toContain("scroll");
    expect(useComputerAction.description).toContain("drag");
  });

  it("has parameters for all action inputs", () => {
    const paramNames = useComputerAction.parameters!.map((p) => p.name);
    expect(paramNames).toContain("action");
    expect(paramNames).toContain("coordinate");
    expect(paramNames).toContain("startCoordinate");
    expect(paramNames).toContain("text");
    expect(paramNames).toContain("key");
    expect(paramNames).toContain("scrollDirection");
    expect(paramNames).toContain("scrollAmount");
  });

  it("has examples", () => {
    expect(Array.isArray(useComputerAction.examples)).toBe(true);
    expect(useComputerAction.examples!.length).toBeGreaterThan(0);
  });

  it("validator returns false when service is not available", async () => {
    const runtime = createMockRuntime(false);
    const msg = createMockMessage("click at 100, 200");
    const result = await useComputerAction.validate(runtime, msg);
    expect(result).toBe(false);
  });

  it("validator returns true when service is available", async () => {
    const runtime = createMockRuntime(true);
    const msg = createMockMessage("click at 100, 200");
    const result = await useComputerAction.validate(runtime, msg);
    expect(result).toBe(true);
  });

  it("defaults to screenshot and returns an attachment through the callback", async () => {
    const executeDesktopAction = vi.fn().mockResolvedValue({
      success: true,
      screenshot: Buffer.from("png-bytes").toString("base64"),
    });
    const callback = vi.fn();
    const runtime = createMockRuntime(true, {
      executeDesktopAction,
      getCapabilities: () => ({
        screenshot: { available: true, tool: "test" },
        computerUse: { available: true, tool: "test" },
        windowList: { available: true, tool: "test" },
        browser: { available: true, tool: "test" },
      }),
    });

    const result = await useComputerAction.handler(
      runtime,
      createMockMessage("take a look"),
      undefined,
      undefined,
      callback,
    );

    expect(executeDesktopAction).toHaveBeenCalledWith({ action: "screenshot" });
    expect(result).toEqual({ success: true, data: { screenshot: true } });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Here is the current screen.",
        attachments: [
          expect.objectContaining({
            title: "Screenshot",
            contentType: "image",
          }),
        ],
      }),
    );
  });
});

// ── TAKE_SCREENSHOT ─────────────────────────────────────────────────────

describe("TAKE_SCREENSHOT action", () => {
  it("has correct name and similes", () => {
    expect(takeScreenshotAction.name).toBe("TAKE_SCREENSHOT");
    expect(Array.isArray(takeScreenshotAction.similes)).toBe(true);
    expect(takeScreenshotAction.similes).toContain("CAPTURE_SCREEN");
    expect(takeScreenshotAction.similes).toContain("SEE_SCREEN");
  });

  it("has no required parameters", () => {
    expect(takeScreenshotAction.parameters).toEqual([]);
  });

  it("has examples", () => {
    expect(Array.isArray(takeScreenshotAction.examples)).toBe(true);
    expect(takeScreenshotAction.examples!.length).toBeGreaterThan(0);
  });

  it("validator returns false when service is not available", async () => {
    const runtime = createMockRuntime(false);
    const result = await takeScreenshotAction.validate(runtime, createMockMessage());
    expect(result).toBe(false);
  });

  it("captures the screen and emits a screenshot attachment", async () => {
    const executeDesktopAction = vi.fn().mockResolvedValue({
      success: true,
      screenshot: Buffer.from("png-bytes").toString("base64"),
    });
    const callback = vi.fn();
    const runtime = createMockRuntime(true, {
      executeDesktopAction,
      getCapabilities: () => ({
        screenshot: { available: true, tool: "test" },
      }),
    });

    const result = await takeScreenshotAction.handler(
      runtime,
      createMockMessage(),
      undefined,
      undefined,
      callback,
    );

    expect(executeDesktopAction).toHaveBeenCalledWith({ action: "screenshot" });
    expect(result).toEqual({ success: true });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Here is the current screen.",
        attachments: [
          expect.objectContaining({
            title: "Screenshot",
            contentType: "image",
          }),
        ],
      }),
    );
  });
});

// ── BROWSER_ACTION ──────────────────────────────────────────────────────

describe("BROWSER_ACTION action", () => {
  it("has correct name and similes", () => {
    expect(browserAction.name).toBe("BROWSER_ACTION");
    expect(Array.isArray(browserAction.similes)).toBe(true);
    expect(browserAction.similes).toContain("CONTROL_BROWSER");
    expect(browserAction.similes).toContain("OPEN_BROWSER");
    expect(browserAction.similes).toContain("BROWSE_WEB");
  });

  it("description covers all browser action types", () => {
    expect(browserAction.description).toContain("open");
    expect(browserAction.description).toContain("close");
    expect(browserAction.description).toContain("navigate");
    expect(browserAction.description).toContain("click");
    expect(browserAction.description).toContain("type");
    expect(browserAction.description).toContain("scroll");
    expect(browserAction.description).toContain("screenshot");
    expect(browserAction.description).toContain("dom");
    expect(browserAction.description).toContain("clickables");
    expect(browserAction.description).toContain("execute");
    expect(browserAction.description).toContain("list_tabs");
  });

  it("has parameters for all browser inputs", () => {
    const paramNames = browserAction.parameters!.map((p) => p.name);
    expect(paramNames).toContain("action");
    expect(paramNames).toContain("url");
    expect(paramNames).toContain("selector");
    expect(paramNames).toContain("coordinate");
    expect(paramNames).toContain("text");
    expect(paramNames).toContain("code");
    expect(paramNames).toContain("direction");
    expect(paramNames).toContain("tabId");
  });

  it("validator returns false when service is not available", async () => {
    const runtime = createMockRuntime(false);
    const result = await browserAction.validate(runtime, createMockMessage());
    expect(result).toBe(false);
  });

  it("returns screenshot attachments for browser screenshot actions", async () => {
    const executeBrowserAction = vi.fn().mockResolvedValue({
      success: true,
      screenshot: Buffer.from("browser-png").toString("base64"),
      content: "Browser screenshot captured.",
    });
    const callback = vi.fn();
    const runtime = createMockRuntime(true, {
      executeBrowserAction,
      getCapabilities: () => ({
        screenshot: { available: true, tool: "test" },
        computerUse: { available: true, tool: "test" },
        windowList: { available: true, tool: "test" },
        browser: { available: true, tool: "test" },
      }),
    });

    const result = await browserAction.handler(
      runtime,
      createMockMessage(),
      undefined,
      { parameters: { action: "screenshot" } } as never,
      callback,
    );

    expect(executeBrowserAction).toHaveBeenCalledWith({ action: "screenshot" });
    expect(result).toEqual({ success: true });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            title: "Browser Screenshot",
            contentType: "image",
          }),
        ],
      }),
    );
  });
});

// ── MANAGE_WINDOW ───────────────────────────────────────────────────────

describe("MANAGE_WINDOW action", () => {
  it("has correct name and similes", () => {
    expect(manageWindowAction.name).toBe("MANAGE_WINDOW");
    expect(Array.isArray(manageWindowAction.similes)).toBe(true);
    expect(manageWindowAction.similes).toContain("LIST_WINDOWS");
    expect(manageWindowAction.similes).toContain("FOCUS_WINDOW");
    expect(manageWindowAction.similes).toContain("ARRANGE_WINDOWS");
    expect(manageWindowAction.similes).toContain("MOVE_WINDOW");
    expect(manageWindowAction.similes).toContain("CLOSE_WINDOW");
  });

  it("description covers window action types", () => {
    expect(manageWindowAction.description).toContain("list");
    expect(manageWindowAction.description).toContain("focus");
    expect(manageWindowAction.description).toContain("switch");
    expect(manageWindowAction.description).toContain("arrange");
    expect(manageWindowAction.description).toContain("move");
    expect(manageWindowAction.description).toContain("minimize");
    expect(manageWindowAction.description).toContain("maximize");
    expect(manageWindowAction.description).toContain("restore");
    expect(manageWindowAction.description).toContain("close");
  });

  it("has parameters", () => {
    const paramNames = manageWindowAction.parameters!.map((p) => p.name);
    expect(paramNames).toContain("action");
    expect(paramNames).toContain("windowId");
    expect(paramNames).toContain("windowTitle");
    expect(paramNames).toContain("arrangement");
    expect(paramNames).toContain("x");
    expect(paramNames).toContain("y");
  });

  it("validator returns false when service is not available", async () => {
    const runtime = createMockRuntime(false);
    const result = await manageWindowAction.validate(runtime, createMockMessage());
    expect(result).toBe(false);
  });

  it("validator returns true when service is available", async () => {
    const runtime = createMockRuntime(true);
    const result = await manageWindowAction.validate(runtime, createMockMessage());
    expect(result).toBe(true);
  });

  it("formats listed windows in the callback", async () => {
    const executeWindowAction = vi.fn().mockResolvedValue({
      success: true,
      windows: [{ id: "1", app: "Chrome", title: "Docs" }],
    });
    const callback = vi.fn();
    const runtime = createMockRuntime(true, {
      executeWindowAction,
      getCapabilities: () => ({
        screenshot: { available: true, tool: "test" },
        computerUse: { available: true, tool: "test" },
        windowList: { available: true, tool: "test" },
        browser: { available: true, tool: "test" },
      }),
    });

    const result = await manageWindowAction.handler(
      runtime,
      createMockMessage(),
      undefined,
      { parameters: { action: "list" } } as never,
      callback,
    );

    expect(executeWindowAction).toHaveBeenCalledWith({ action: "list" });
    expect(result).toEqual({ success: true });
    expect(callback).toHaveBeenCalledWith({
      text: "Open windows:\n[1] Chrome — Docs",
    });
  });
});
