import {
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalAction } from "./terminal.ts";

function makeRuntime(): IAgentRuntime {
  return {
    actions: [terminalAction],
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function makeMessage(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000012087",
    entityId: "00000000-0000-0000-0000-000000000001",
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "run echo hello" },
  } as Memory;
}

describe("terminalAction runtime role gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks non-owner callers before terminal execution reaches the handler transport", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executePlannedToolCall(
      makeRuntime(),
      {
        message: makeMessage(),
        activeContexts: ["terminal"],
        userRoles: ["MEMBER"],
      },
      { name: "TERMINAL_SHELL", params: { command: "echo hello" } },
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
