import { afterEach, describe, expect, it, vi } from "vitest";

const sendAppRunMessage = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/app-core/ui-compat", () => ({
  client: { sendAppRunMessage },
}));

import { interact } from "./DefenseAgentsOperatorSurface.interact";

afterEach(() => {
  vi.clearAllMocks();
});

describe("Defense interact() TUI capability handler", () => {
  it("returns the terminal state with lanes and the real primary command set", async () => {
    const state = (await interact("terminal-defense-state")) as {
      viewType: string;
      appName: string;
      lanes: string[];
      primaryCommands: string[];
    };

    expect(state).toEqual({
      viewType: "tui",
      appName: "@elizaos/plugin-defense-of-the-agents",
      lanes: ["top", "mid", "bot"],
      primaryCommands: [
        "review strategy",
        "move to top",
        "move to mid",
        "move to bot",
        "recall",
      ],
    });
    // terminal-defense-state is a pure local read; it must not hit the client.
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("dispatches terminal-defense-command through the app-run client", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Recalling.",
    });

    const result = (await interact("terminal-defense-command", {
      runId: "run-7",
      content: "  recall  ",
    })) as { viewType: string; command: { success: boolean } };

    // Surrounding whitespace must be trimmed before dispatch.
    expect(sendAppRunMessage).toHaveBeenCalledWith("run-7", "recall");
    expect(result.viewType).toBe("tui");
    expect(result.command).toEqual({ success: true, message: "Recalling." });
  });

  it("throws when runId is missing or blank, without calling the client", async () => {
    await expect(
      interact("terminal-defense-command", { content: "recall" }),
    ).rejects.toThrow("runId is required");
    await expect(
      interact("terminal-defense-command", {
        runId: "   ",
        content: "recall",
      }),
    ).rejects.toThrow("runId is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("throws when content is missing or blank, without calling the client", async () => {
    await expect(
      interact("terminal-defense-command", { runId: "run-1" }),
    ).rejects.toThrow("content is required");
    await expect(
      interact("terminal-defense-command", {
        runId: "run-1",
        content: "   ",
      }),
    ).rejects.toThrow("content is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("throws on an unknown capability", async () => {
    await expect(interact("terminal-defense-bogus")).rejects.toThrow(
      "Unsupported Defense TUI capability: terminal-defense-bogus",
    );
  });
});
