/**
 * Tests for all action definitions — structure, validation, and parameters.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { browserAction } from "../actions/browser-action.js";
import { fileAction } from "../actions/file-action.js";
import { manageWindowAction } from "../actions/manage-window.js";
import { terminalAction } from "../actions/terminal-action.js";
import { useComputerAction } from "../actions/use-computer.js";

function mockRuntime(hasService: boolean): IAgentRuntime {
  return {
    character: {},
    getService(name: string) {
      if (!hasService) return null;
      return {
        getCapabilities: () => ({
          screenshot: { available: true, tool: "test" },
          computerUse: { available: true, tool: "test" },
          windowList: { available: true, tool: "test" },
          browser: { available: true, tool: "test" },
          terminal: { available: true, tool: "test" },
          fileSystem: { available: true, tool: "test" },
        }),
      };
    },
  } as unknown as IAgentRuntime;
}

function mockMessage(text = ""): Memory {
  return {
    content: { text },
    roomId: "r" as any,
    agentId: "a" as any,
  } as Memory;
}

describe("USE_COMPUTER action", () => {
  it("has correct name and similes", () => {
    expect(useComputerAction.name).toBe("USE_COMPUTER");
    expect(useComputerAction.similes).toContain("CLICK");
    expect(useComputerAction.similes).toContain("TYPE_TEXT");
    expect(useComputerAction.similes).toContain("SCROLL_SCREEN");
    expect(useComputerAction.similes).toContain("DRAG");
  });

  it("has parameters for all inputs", () => {
    const names = useComputerAction.parameters!.map((p) => p.name);
    expect(names).toContain("action");
    expect(names).toContain("coordinate");
    expect(names).toContain("text");
    expect(names).toContain("key");
    expect(names).toContain("scrollDirection");
    expect(new Set(names).size).toBe(names.length);
  });

  it("validates: false without service", async () => {
    expect(
      await useComputerAction.validate(mockRuntime(false), mockMessage()),
    ).toBe(false);
  });

  it("validates: true with service", async () => {
    expect(
      await useComputerAction.validate(mockRuntime(true), mockMessage()),
    ).toBe(true);
  });

  it("returns a structured ActionResult and emits one desktop callback", async () => {
    const executeDesktopAction = vi.fn(async () => ({
      success: true,
      message: "Clicked.",
      screenshot: "base64-image",
    }));
    const runtime = {
      getService(name: string) {
        if (name !== "computeruse") return null;
        return {
          executeDesktopAction,
          getCapabilities: () => ({
            computerUse: { available: true, tool: "test" },
          }),
        };
      },
    } as unknown as IAgentRuntime;
    const callback = vi.fn(async () => []);

    const result = await useComputerAction.handler(
      runtime,
      {
        ...mockMessage(),
        content: { action: "click", coordinate: [10, 20] },
      } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    const actionResult = result!;
    expect(actionResult).toMatchObject({
      success: true,
      text: "Clicked.",
      data: {
        source: "computeruse",
        computerUseAction: "click",
        suppressActionResultClipboard: true,
        result: { hasScreenshot: true },
      },
    });
    expect(
      (actionResult.data?.result as { screenshot?: unknown } | undefined)
        ?.screenshot,
    ).toBeUndefined();
  });
});

describe("USE_COMPUTER screenshot similes (merged from removed TAKE_SCREENSHOT)", () => {
  it("includes screenshot-related similes", () => {
    expect(useComputerAction.similes).toContain("TAKE_SCREENSHOT");
    expect(useComputerAction.similes).toContain("CAPTURE_SCREEN");
    expect(useComputerAction.similes).toContain("SEE_SCREEN");
  });
});

describe("BROWSER_ACTION action", () => {
  it("has correct name and similes", () => {
    expect(browserAction.name).toBe("BROWSER_ACTION");
    expect(browserAction.similes).toContain("OPEN_BROWSER");
    expect(browserAction.similes).toContain("BROWSE_WEB");
  });

  it("has parameters for browser inputs", () => {
    const names = browserAction.parameters!.map((p) => p.name);
    expect(names).toContain("action");
    expect(names).toContain("url");
    expect(names).toContain("selector");
    expect(names).toContain("text");
    expect(names).toContain("code");
  });
});

describe("MANAGE_WINDOW action", () => {
  it("has correct name and similes", () => {
    expect(manageWindowAction.name).toBe("MANAGE_WINDOW");
    expect(manageWindowAction.similes).toContain("LIST_WINDOWS");
    expect(manageWindowAction.similes).toContain("FOCUS_WINDOW");
  });

  it("validates: true with service", async () => {
    expect(
      await manageWindowAction.validate(mockRuntime(true), mockMessage()),
    ).toBe(true);
  });
});

describe("FILE_ACTION action", () => {
  it("has correct name and similes", () => {
    expect(fileAction.name).toBe("FILE_ACTION");
    expect(fileAction.similes).toContain("READ_FILE");
    expect(fileAction.similes).toContain("WRITE_FILE");
    expect(fileAction.similes).toContain("LIST_DIRECTORY");
  });

  it("has parameters for file operations", () => {
    const names = fileAction.parameters!.map((p) => p.name);
    expect(names).toContain("action");
    expect(names).toContain("path");
    expect(names).toContain("content");
    expect(names).toContain("oldText");
    expect(names).toContain("newText");
  });

  it("description covers all file action types", () => {
    expect(fileAction.description).toContain("read");
    expect(fileAction.description).toContain("write");
    expect(fileAction.description).toContain("edit");
    expect(fileAction.description).toContain("append");
    expect(fileAction.description).toContain("delete");
    expect(fileAction.description).toContain("exists");
    expect(fileAction.description).toContain("list");
  });

  it("validates: false without service", async () => {
    expect(await fileAction.validate(mockRuntime(false), mockMessage())).toBe(
      false,
    );
  });

  it("validates: true with service", async () => {
    expect(await fileAction.validate(mockRuntime(true), mockMessage())).toBe(
      true,
    );
  });
});

describe("TERMINAL_ACTION action", () => {
  it("has correct name and similes", () => {
    expect(terminalAction.name).toBe("TERMINAL_ACTION");
    expect(terminalAction.similes).toContain("RUN_COMMAND");
    expect(terminalAction.similes).toContain("EXECUTE_COMMAND");
    expect(terminalAction.similes).toContain("SHELL_COMMAND");
  });

  it("has parameters for terminal operations", () => {
    const names = terminalAction.parameters!.map((p) => p.name);
    expect(names).toContain("action");
    expect(names).toContain("command");
    expect(names).toContain("cwd");
    expect(names).toContain("sessionId");
  });

  it("description covers all terminal action types", () => {
    expect(terminalAction.description).toContain("execute");
    expect(terminalAction.description).toContain("connect");
    expect(terminalAction.description).toContain("close");
  });

  it("validates: false without service", async () => {
    expect(
      await terminalAction.validate(mockRuntime(false), mockMessage()),
    ).toBe(false);
  });

  it("validates: true with service", async () => {
    expect(
      await terminalAction.validate(mockRuntime(true), mockMessage()),
    ).toBe(true);
  });

  it("owns terminal turns and suppresses terminal output clipboard finalization", () => {
    expect(terminalAction.suppressPostActionContinuation).toBe(true);
  });
});
