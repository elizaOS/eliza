import { describe, expect, test, vi, beforeEach } from "vitest";
import { computeruseClickAction } from "../src/actions/click";
import { computeruseTypeAction } from "../src/actions/type";
import { computeruseOpenApplicationAction } from "../src/actions/open-application";
import { computeruseGetApplicationsAction } from "../src/actions/get-applications";
import { computeruseGetWindowTreeAction } from "../src/actions/get-window-tree";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockService(opts: { enabled?: boolean; backendName?: string } = {}) {
  const { enabled = true, backendName = "mcp" } = opts;
  return {
    isEnabled: () => enabled,
    getBackendName: () => backendName,
    click: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    openApplication: vi.fn().mockResolvedValue(undefined),
    getApplications: vi.fn().mockResolvedValue(["chrome", "notepad", "calc"]),
    getWindowTree: vi.fn().mockResolvedValue('{"tree": "data"}'),
  };
}

function createMockRuntime(service: ReturnType<typeof createMockService> | null): IAgentRuntime {
  return {
    getService: vi.fn().mockReturnValue(service),
  } as unknown as IAgentRuntime;
}

function createMessage(text: string): Memory {
  return {
    id: stringToUuid("test-msg"),
    entityId: stringToUuid("test-user"),
    roomId: stringToUuid("test-room"),
    content: { text, source: "test", channelType: ChannelType.DM },
  } as Memory;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ComputerUse action handlers (unit)", () => {
  let service: ReturnType<typeof createMockService>;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    service = createMockService();
    runtime = createMockRuntime(service);
  });

  // ---- Validation tests ----

  describe("validate - service availability", () => {
    test("CLICK validates false when service is unavailable", async () => {
      const noServiceRuntime = createMockRuntime(null);
      const msg = createMessage("click the button");
      expect(await computeruseClickAction.validate(noServiceRuntime, msg)).toBe(false);
    });

    test("CLICK validates false when service is disabled", async () => {
      const disabledService = createMockService({ enabled: false });
      const disabledRuntime = createMockRuntime(disabledService);
      const msg = createMessage("click the button");
      expect(await computeruseClickAction.validate(disabledRuntime, msg)).toBe(false);
    });

    test("CLICK validates true when service is enabled and text matches", async () => {
      const msg = createMessage("click the button");
      expect(await computeruseClickAction.validate(runtime, msg)).toBe(true);
    });

    test("TYPE validates true for keyword 'type'", async () => {
      const msg = createMessage("type some text into the field");
      expect(await computeruseTypeAction.validate(runtime, msg)).toBe(true);
    });

    test("OPEN_APPLICATION validates true for keyword 'open'", async () => {
      const msg = createMessage("open notepad please");
      expect(await computeruseOpenApplicationAction.validate(runtime, msg)).toBe(true);
    });

    test("GET_APPLICATIONS validates true for keyword 'applications'", async () => {
      const msg = createMessage("list all applications");
      expect(await computeruseGetApplicationsAction.validate(runtime, msg)).toBe(true);
    });

    test("GET_WINDOW_TREE validates true for keyword 'window tree'", async () => {
      const msg = createMessage("show the window tree");
      expect(await computeruseGetWindowTreeAction.validate(runtime, msg)).toBe(true);
    });
  });

  // ---- CLICK handler tests ----

  describe("CLICK handler", () => {
    test("returns failure when service is missing", async () => {
      const noServiceRuntime = createMockRuntime(null);
      const msg = createMessage("click save");
      const result = await computeruseClickAction.handler(
        noServiceRuntime, msg, undefined,
        { parameters: { selector: "role:Button|name:Save" } },
        undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("not available");
    });

    test("returns failure when selector is missing", async () => {
      const msg = createMessage("click something");
      const result = await computeruseClickAction.handler(
        runtime, msg, undefined,
        { parameters: {} },
        undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("selector");
    });

    test("extracts parameters and calls service.click", async () => {
      const msg = createMessage("click save");
      const callback = vi.fn();
      const result = await computeruseClickAction.handler(
        runtime, msg, undefined,
        { parameters: { process: "notepad", selector: "role:Button|name:Save", timeoutMs: 3000 } },
        callback
      );
      expect(result?.success).toBe(true);
      expect(service.click).toHaveBeenCalledWith("role:Button|name:Save", 3000, "notepad");
      expect(callback).toHaveBeenCalled();
      expect(result?.data).toMatchObject({ process: "notepad", selector: "role:Button|name:Save", timeoutMs: 3000, backend: "mcp" });
    });

    test("uses default timeout of 5000ms", async () => {
      const msg = createMessage("click something");
      await computeruseClickAction.handler(
        runtime, msg, undefined,
        { parameters: { selector: "role:Button", process: "chrome" } },
        undefined
      );
      expect(service.click).toHaveBeenCalledWith("role:Button", 5000, "chrome");
    });

    test("handles service error gracefully", async () => {
      service.click.mockRejectedValueOnce(new Error("Element not found"));
      const msg = createMessage("click missing");
      const result = await computeruseClickAction.handler(
        runtime, msg, undefined,
        { parameters: { selector: "role:Missing", process: "app" } },
        undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("Element not found");
    });
  });

  // ---- TYPE handler tests ----

  describe("TYPE handler", () => {
    test("returns failure when text is missing", async () => {
      const msg = createMessage("type into search");
      const result = await computeruseTypeAction.handler(
        runtime, msg, undefined,
        { parameters: { selector: "role:Edit" } },
        undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("text");
    });

    test("extracts all parameters and calls service.typeText", async () => {
      const msg = createMessage("type hello");
      const result = await computeruseTypeAction.handler(
        runtime, msg, undefined,
        {
          parameters: {
            process: "notepad",
            selector: "role:Edit|name:Search",
            text: "hello world",
            timeoutMs: 2000,
            clearBeforeTyping: false,
          },
        },
        undefined
      );
      expect(result?.success).toBe(true);
      expect(service.typeText).toHaveBeenCalledWith(
        "role:Edit|name:Search", "hello world", 2000, false, "notepad"
      );
    });

    test("defaults clearBeforeTyping to true", async () => {
      const msg = createMessage("type something");
      await computeruseTypeAction.handler(
        runtime, msg, undefined,
        { parameters: { selector: "role:Edit", text: "test", process: "chrome" } },
        undefined
      );
      expect(service.typeText).toHaveBeenCalledWith(
        "role:Edit", "test", 5000, true, "chrome"
      );
    });
  });

  // ---- OPEN_APPLICATION handler tests ----

  describe("OPEN_APPLICATION handler", () => {
    test("returns failure when name is missing", async () => {
      const msg = createMessage("open something");
      const result = await computeruseOpenApplicationAction.handler(
        runtime, msg, undefined,
        { parameters: {} },
        undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("name");
    });

    test("calls service.openApplication with correct name", async () => {
      const msg = createMessage("open calc");
      const result = await computeruseOpenApplicationAction.handler(
        runtime, msg, undefined,
        { parameters: { name: "calculator" } },
        undefined
      );
      expect(result?.success).toBe(true);
      expect(service.openApplication).toHaveBeenCalledWith("calculator");
      expect(result?.data).toMatchObject({ name: "calculator", backend: "mcp" });
    });
  });

  // ---- GET_APPLICATIONS handler tests ----

  describe("GET_APPLICATIONS handler", () => {
    test("returns application list on success", async () => {
      const msg = createMessage("list apps");
      const result = await computeruseGetApplicationsAction.handler(
        runtime, msg, undefined, undefined, undefined
      );
      expect(result?.success).toBe(true);
      expect(result?.text).toContain("chrome");
      expect(result?.data?.apps).toEqual(["chrome", "notepad", "calc"]);
    });

    test("handles service errors gracefully", async () => {
      service.getApplications.mockRejectedValueOnce(new Error("MCP timeout"));
      const msg = createMessage("list apps");
      const result = await computeruseGetApplicationsAction.handler(
        runtime, msg, undefined, undefined, undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("MCP timeout");
    });
  });

  // ---- GET_WINDOW_TREE handler tests ----

  describe("GET_WINDOW_TREE handler", () => {
    test("returns failure when process is missing", async () => {
      const msg = createMessage("dump tree");
      const result = await computeruseGetWindowTreeAction.handler(
        runtime, msg, undefined,
        { parameters: {} },
        undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("process");
    });

    test("passes optional title and maxDepth to service", async () => {
      const msg = createMessage("get ui tree");
      const result = await computeruseGetWindowTreeAction.handler(
        runtime, msg, undefined,
        { parameters: { process: "notepad", title: "Untitled", maxDepth: 4 } },
        undefined
      );
      expect(result?.success).toBe(true);
      expect(service.getWindowTree).toHaveBeenCalledWith("notepad", "Untitled", 4);
      expect(result?.data).toMatchObject({ process: "notepad", title: "Untitled", maxDepth: 4 });
    });

    test("handles service error gracefully", async () => {
      service.getWindowTree.mockRejectedValueOnce(new Error("Process not found"));
      const msg = createMessage("get window tree");
      const result = await computeruseGetWindowTreeAction.handler(
        runtime, msg, undefined,
        { parameters: { process: "unknown" } },
        undefined
      );
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("Process not found");
    });
  });
});
