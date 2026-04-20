import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { automationTerminalBridgeProvider } from "./automation-terminal-bridge.js";
import { recentConversationsProvider } from "./recent-conversations.js";
import { relevantConversationsProvider } from "./relevant-conversations.js";

function automationRoomMetadata(overrides?: Record<string, unknown>) {
  return {
    webConversation: {
      conversationId: "automation-conv-1",
      scope: "automation-workflow",
      automationType: "n8n_workflow",
      workflowId: "wf-1",
      terminalBridgeConversationId: "terminal-conv-1",
      ...overrides,
    },
  };
}

function buildMessage(overrides?: Partial<Memory>): Memory {
  return {
    id: "msg-1" as UUID,
    roomId: "room-1" as UUID,
    entityId: "agent-1" as UUID,
    content: {
      text: "Build a workflow for me",
    },
    ...overrides,
  } as Memory;
}

describe("automation room providers", () => {
  it("skips recent cross-room conversation search inside automation rooms", async () => {
    const runtime = {
      agentId: "agent-1",
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: automationRoomMetadata(),
      })),
      getRoomsForParticipant: vi.fn(),
    };

    await expect(
      recentConversationsProvider.get(runtime as never, buildMessage(), {} as never),
    ).resolves.toEqual({
      text: "",
      values: {},
      data: {},
    });

    expect(runtime.getRoomsForParticipant).not.toHaveBeenCalled();
  });

  it("skips semantic cross-room search inside automation rooms", async () => {
    const runtime = {
      agentId: "agent-1",
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: automationRoomMetadata(),
      })),
      useModel: vi.fn(),
      searchMemories: vi.fn(),
    };

    await expect(
      relevantConversationsProvider.get(
        runtime as never,
        buildMessage(),
        {} as never,
      ),
    ).resolves.toEqual({
      text: "",
      values: {},
      data: {},
    });

    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(runtime.searchMemories).not.toHaveBeenCalled();
  });

  it("bridges the linked terminal conversation into automation rooms", async () => {
    const runtime = {
      agentId: "agent-1",
      entities: new Map(),
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: automationRoomMetadata(),
      })),
      getMemories: vi.fn(async () => [
        {
          id: "term-1",
          roomId: "linked-room",
          entityId: "agent-1",
          createdAt: 1_700_000_000_000,
          content: {
            text: "Draft a workflow from today’s terminal work.",
          },
        },
      ]),
    };

    const result = await automationTerminalBridgeProvider.get(
      runtime as never,
      buildMessage(),
    );

    expect(result.values).toMatchObject({
      terminalBridgeConversationId: "terminal-conv-1",
      terminalBridgeMessageCount: 1,
    });
    expect(result.text).toContain("Linked terminal conversation:");
    expect(result.data).toMatchObject({
      conversationId: "terminal-conv-1",
      messages: [
        {
          id: "term-1",
          text: "Draft a workflow from today’s terminal work.",
        },
      ],
    });
    expect(runtime.getMemories).toHaveBeenCalledTimes(1);
  });
});
