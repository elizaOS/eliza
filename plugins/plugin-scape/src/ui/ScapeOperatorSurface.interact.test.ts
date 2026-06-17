import { afterEach, describe, expect, it, vi } from "vitest";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const controlAppRun = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/app-core/ui-compat", () => ({
  client: { sendAppRunMessage, controlAppRun },
}));

import { interact } from "./ScapeOperatorSurface.interact";

afterEach(() => {
  vi.clearAllMocks();
});

describe("'scape interact() TUI capability handler", () => {
  it("terminal-scape-state returns metadata + command list without hitting the client", async () => {
    const state = (await interact("terminal-scape-state")) as {
      viewType: string;
      appName: string;
      commands: string[];
    };

    expect(state).toEqual({
      viewType: "tui",
      appName: "@elizaos/plugin-scape",
      commands: ["terminal-scape-command", "terminal-scape-control"],
    });
    expect(sendAppRunMessage).not.toHaveBeenCalled();
    expect(controlAppRun).not.toHaveBeenCalled();
  });

  it("terminal-scape-command forwards (trimmed) runId + content to sendAppRunMessage", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "queued" });

    const result = (await interact("terminal-scape-command", {
      runId: "  run-7  ",
      content: "  walk to the cows  ",
    })) as { viewType: string; command: { success: boolean; message: string } };

    expect(sendAppRunMessage).toHaveBeenCalledWith("run-7", "walk to the cows");
    expect(result.viewType).toBe("tui");
    expect(result.command).toEqual({ success: true, message: "queued" });
  });

  it("terminal-scape-command throws on missing/blank runId without calling the client", async () => {
    await expect(
      interact("terminal-scape-command", { content: "hi" }),
    ).rejects.toThrow("runId is required");
    await expect(
      interact("terminal-scape-command", { runId: "   ", content: "hi" }),
    ).rejects.toThrow("runId is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("terminal-scape-command throws on missing/blank content without calling the client", async () => {
    await expect(
      interact("terminal-scape-command", { runId: "run-1" }),
    ).rejects.toThrow("content is required");
    await expect(
      interact("terminal-scape-command", { runId: "run-1", content: "   " }),
    ).rejects.toThrow("content is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("terminal-scape-control forwards a valid pause action to controlAppRun", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "Paused." });

    const result = (await interact("terminal-scape-control", {
      runId: "run-9",
      action: "pause",
    })) as { viewType: string; control: { success: boolean } };

    expect(controlAppRun).toHaveBeenCalledWith("run-9", "pause");
    expect(result.viewType).toBe("tui");
    expect(result.control).toEqual({ success: true, message: "Paused." });
  });

  it("terminal-scape-control forwards a valid resume action to controlAppRun", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "Resumed." });

    await interact("terminal-scape-control", {
      runId: "run-9",
      action: "resume",
    });
    expect(controlAppRun).toHaveBeenCalledWith("run-9", "resume");
  });

  it("terminal-scape-control throws on a blank runId without calling the client", async () => {
    await expect(
      interact("terminal-scape-control", { runId: "   ", action: "pause" }),
    ).rejects.toThrow("runId is required");
    expect(controlAppRun).not.toHaveBeenCalled();
  });

  it("terminal-scape-control throws on an invalid action without calling the client", async () => {
    await expect(
      interact("terminal-scape-control", { runId: "run-1", action: "stop" }),
    ).rejects.toThrow("action must be pause or resume");
    expect(controlAppRun).not.toHaveBeenCalled();
  });

  it("throws on an unsupported capability", async () => {
    await expect(interact("terminal-scape-bogus")).rejects.toThrow(
      "Unsupported 'scape TUI capability: terminal-scape-bogus",
    );
  });
});
