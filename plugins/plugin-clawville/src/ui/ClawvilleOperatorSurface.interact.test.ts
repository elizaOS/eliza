import { afterEach, describe, expect, it, vi } from "vitest";

const sendAppRunMessage = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  client: { sendAppRunMessage },
}));

import { interact } from "./ClawvilleOperatorSurface.interact";

afterEach(() => {
  vi.clearAllMocks();
});

describe("ClawVille interact() TUI capability handler", () => {
  it("returns the terminal state with the real primary command set", async () => {
    const state = (await interact("terminal-clawville-state")) as {
      viewType: string;
      appName: string;
      primaryCommands: string[];
    };

    expect(state).toEqual({
      viewType: "tui",
      appName: "@elizaos/plugin-clawville",
      primaryCommands: [
        "Visit the nearest building",
        "Ask the nearest NPC what to learn next",
      ],
    });
    // terminal-clawville-state is a pure local read; it must not hit the client.
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("dispatches terminal-clawville-command through the app-run client", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "queued",
      disposition: "queued",
      status: 202,
    });

    const result = (await interact("terminal-clawville-command", {
      runId: "run-7",
      content: "  Move to skill forge  ",
    })) as { viewType: string; command: { disposition: string } };

    // Surrounding whitespace must be trimmed before dispatch.
    expect(sendAppRunMessage).toHaveBeenCalledWith(
      "run-7",
      "Move to skill forge",
    );
    expect(result.viewType).toBe("tui");
    expect(result.command).toEqual({
      success: true,
      message: "queued",
      disposition: "queued",
      status: 202,
    });
  });

  it("throws when runId is missing or blank, without calling the client", async () => {
    await expect(
      interact("terminal-clawville-command", { content: "hello" }),
    ).rejects.toThrow("runId is required");
    await expect(
      interact("terminal-clawville-command", {
        runId: "   ",
        content: "hello",
      }),
    ).rejects.toThrow("runId is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("throws when content is missing or blank, without calling the client", async () => {
    await expect(
      interact("terminal-clawville-command", { runId: "run-1" }),
    ).rejects.toThrow("content is required");
    await expect(
      interact("terminal-clawville-command", {
        runId: "run-1",
        content: "   ",
      }),
    ).rejects.toThrow("content is required");
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("throws on an unknown capability", async () => {
    await expect(interact("terminal-clawville-bogus")).rejects.toThrow(
      "Unsupported ClawVille TUI capability: terminal-clawville-bogus",
    );
  });
});
