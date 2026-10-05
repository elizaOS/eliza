/**
 * Regression for the chat dedupe fail-open: dedupe reads must fail closed so
 * a storage blip surfaces as an error instead of duplicating user-visible
 * assistant replies.
 */
import {
  type AgentRuntime,
  ChannelType,
  ElizaError,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  getRecentVisibleAssistantMemorySince,
  persistAssistantConversationMemory,
} from "./chat-routes.ts";

function failingRuntime() {
  return {
    agentId: "agent-1",
    getMemories: vi.fn().mockRejectedValue(new Error("db blip")),
    createMemory: vi.fn().mockResolvedValue({ id: "new" }),
  } as unknown as AgentRuntime & {
    getMemories: ReturnType<typeof vi.fn>;
    createMemory: ReturnType<typeof vi.fn>;
  };
}

describe("chat dedupe reads fail closed", () => {
  it("does not persist a duplicate when the dedupe read fails", async () => {
    const runtime = failingRuntime();
    await expect(
      persistAssistantConversationMemory(
        runtime,
        "room-1" as UUID,
        "hello",
        ChannelType.API,
        Date.now(),
      ),
    ).rejects.toBeInstanceOf(ElizaError);
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("surfaces the visible-memory read failure instead of reporting no prior reply", async () => {
    const runtime = failingRuntime();
    await expect(
      getRecentVisibleAssistantMemorySince(
        runtime,
        "room-1" as UUID,
        Date.now(),
      ),
    ).rejects.toBeInstanceOf(ElizaError);
  });
});
