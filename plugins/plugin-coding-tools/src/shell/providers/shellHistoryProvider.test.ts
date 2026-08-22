/**
 * Verifies that SHELL_HISTORY projects a bounded recent window without mutating
 * the ShellService-owned full command history.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ShellService } from "../services/shellService";
import type { CommandHistoryEntry } from "../types";
import { shellHistoryProvider } from "./shellHistoryProvider";

describe("SHELL_HISTORY provider", () => {
  it("caps recent output while leaving complete service history intact", async () => {
    const largeOutput = "z".repeat(5_000);
    const fullHistory: CommandHistoryEntry[] = Array.from(
      { length: 12 },
      (_, index) => ({
        command: `command-${index}`,
        stdout: index === 11 ? largeOutput : `output-${index}`,
        stderr: "",
        exitCode: 0,
        timestamp: Date.UTC(2026, 0, 1, 0, index),
        workingDirectory: "/workspace",
      }),
    );
    const getCommandHistory = vi.fn(
      (_conversationId: string, limit?: number) =>
        limit ? fullHistory.slice(-limit) : fullHistory,
    );
    const service = {
      getCommandHistory,
      getCurrentDirectory: () => "/workspace",
      getAllowedDirectory: () => "/workspace",
    } as unknown as ShellService;
    const runtime = {
      character: {},
      getService: (name: string) => (name === "shell" ? service : null),
      redactSecrets: (text: string) => text,
    } as unknown as IAgentRuntime;

    const result = await shellHistoryProvider.get(
      runtime,
      { roomId: "room-bounded-history", agentId: "agent-1" } as never,
      {} as never,
    );

    expect(getCommandHistory).toHaveBeenCalledWith("room-bounded-history", 10);
    expect(fullHistory).toHaveLength(12);
    expect(fullHistory[11]?.stdout).toBe(largeOutput);
    expect(result.text).not.toContain("command-0");
    expect(result.text).not.toMatch(/command-1(?:\D|$)/);
    expect(result.text).toContain("command-2");
    expect(result.text).toContain("command-11");
    expect(result.text).not.toContain(largeOutput);
    expect(result.text).toContain("characters omitted");
    expect(result.text?.length).toBeLessThanOrEqual(24_000);
    expect(result.data?.historyCount).toBe(10);
  });
});
