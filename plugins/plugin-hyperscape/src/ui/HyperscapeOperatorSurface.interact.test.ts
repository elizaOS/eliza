import { afterEach, describe, expect, it, vi } from "vitest";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const controlAppRun = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/app-core/ui-compat", () => ({
  client: { sendAppRunMessage, controlAppRun },
}));

import { interact } from "./HyperscapeOperatorSurface.interact";

afterEach(() => {
  vi.clearAllMocks();
});

describe("Hyperscape interact() TUI capability handler", () => {
  it("returns the terminal state with the supported command set without hitting the client", async () => {
    const state = (await interact("terminal-hyperscape-state")) as {
      viewType: string;
      appName: string;
      commands: string[];
    };

    expect(state).toEqual({
      viewType: "tui",
      appName: "@elizaos/plugin-hyperscape",
      commands: ["terminal-hyperscape-command", "terminal-hyperscape-control"],
    });
    expect(sendAppRunMessage).not.toHaveBeenCalled();
    expect(controlAppRun).not.toHaveBeenCalled();
  });

  it("dispatches terminal-hyperscape-command through the app-run client (trimming content)", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "queued" });

    const result = (await interact("terminal-hyperscape-command", {
      runId: "  run-7  ",
      content: "  look around  ",
    })) as { viewType: string; command: { message: string } };

    // runId + content are both trimmed before dispatch.
    expect(sendAppRunMessage).toHaveBeenCalledWith("run-7", "look around");
    expect(result.viewType).toBe("tui");
    expect(result.command).toEqual({ success: true, message: "queued" });
  });

  it("throws when runId is missing or blank, without calling the client", async () => {
    await expect(
      interact("terminal-hyperscape-command", { content: "hello" }),
    ).rejects.toThrow("runId is required");
    await expect(
      interact("terminal-hyperscape-command", {
        runId: "   ",
        content: "hello",
      }),
    ).rejects.toThrow("runId is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("throws when content is missing or blank, without calling the client", async () => {
    await expect(
      interact("terminal-hyperscape-command", { runId: "run-1" }),
    ).rejects.toThrow("content is required");
    await expect(
      interact("terminal-hyperscape-command", {
        runId: "run-1",
        content: "   ",
      }),
    ).rejects.toThrow("content is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("dispatches terminal-hyperscape-control with a valid pause action", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "Paused." });

    const result = (await interact("terminal-hyperscape-control", {
      runId: "run-9",
      action: "pause",
    })) as { viewType: string; control: { message: string } };

    expect(controlAppRun).toHaveBeenCalledWith("run-9", "pause");
    expect(result.viewType).toBe("tui");
    expect(result.control).toEqual({ success: true, message: "Paused." });
  });

  it("dispatches terminal-hyperscape-control with a valid resume action", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "Resumed." });

    await interact("terminal-hyperscape-control", {
      runId: "run-9",
      action: "resume",
    });
    expect(controlAppRun).toHaveBeenCalledWith("run-9", "resume");
  });

  it("throws when the control action is invalid, without calling the client", async () => {
    await expect(
      interact("terminal-hyperscape-control", {
        runId: "run-1",
        action: "stop",
      }),
    ).rejects.toThrow("action must be pause or resume");
    expect(controlAppRun).not.toHaveBeenCalled();
  });

  it("throws when the control runId is blank", async () => {
    await expect(
      interact("terminal-hyperscape-control", {
        runId: "   ",
        action: "pause",
      }),
    ).rejects.toThrow("runId is required");
    expect(controlAppRun).not.toHaveBeenCalled();
  });

  it("throws on an unknown capability", async () => {
    await expect(interact("terminal-hyperscape-bogus")).rejects.toThrow(
      "Unsupported Hyperscape TUI capability: terminal-hyperscape-bogus",
    );
  });
});
