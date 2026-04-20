import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { resolveChatAdminEntityId } from "./chat-routes.js";
import {
  buildPersistedAssistantContent,
  formatConversationMessageText,
  persistRecentAssistantActionCallbackHistory,
  resolveConversationAdminEntityId,
} from "./conversation-routes.js";

describe("conversation callback history persistence", () => {
  it("prefers the canonical runtime owner for app chat conversations", () => {
    const state = {
      runtime: {
        getSetting: (key: string) =>
          key === "ELIZA_ADMIN_ENTITY_ID"
            ? "00000000-0000-0000-0000-000000000123"
            : undefined,
      },
      config: {},
      agentName: "Eliza",
      adminEntityId: "00000000-0000-0000-0000-00000000f00d",
      chatUserId: null,
      logBuffer: [],
      conversations: new Map(),
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    } as Parameters<typeof resolveConversationAdminEntityId>[0];

    expect(resolveConversationAdminEntityId(state)).toBe(
      "00000000-0000-0000-0000-000000000123",
    );
    expect(state.adminEntityId).toBe("00000000-0000-0000-0000-000000000123");
    expect(state.chatUserId).toBe("00000000-0000-0000-0000-000000000123");
  });

  it("prefers the canonical runtime owner for compat chat routes", () => {
    const state = {
      runtime: {
        getSetting: (key: string) =>
          key === "ELIZA_ADMIN_ENTITY_ID"
            ? "00000000-0000-0000-0000-000000000456"
            : undefined,
      },
      config: {},
      agentName: "Eliza",
      adminEntityId: "00000000-0000-0000-0000-00000000f00d",
      chatUserId: null,
      logBuffer: [],
      chatRoomId: null,
      chatConnectionReady: null,
      chatConnectionPromise: null,
    } as Parameters<typeof resolveChatAdminEntityId>[0];

    expect(resolveChatAdminEntityId(state)).toBe(
      "00000000-0000-0000-0000-000000000456",
    );
    expect(state.adminEntityId).toBe("00000000-0000-0000-0000-000000000456");
    expect(state.chatUserId).toBe("00000000-0000-0000-0000-000000000456");
  });

  it("formats callback history without duplicating the final text", () => {
    expect(
      formatConversationMessageText("Now playing: **Track**", [
        "Looking up track...",
        "Searching for track...",
        "Now playing: **Track**",
      ]),
    ).toBe(
      "Looking up track...\nSearching for track...\n\nNow playing: **Track**",
    );
  });

  it("stores callback history on persisted assistant content", () => {
    expect(
      buildPersistedAssistantContent("Now playing: **Track**", {
        actionCallbackHistory: [
          "Looking up track...",
          "Now playing: **Track**",
        ],
        responseContent: {
          text: "Now playing: **Track**",
        },
      }),
    ).toMatchObject({
      text: "Now playing: **Track**",
      actionCallbackHistory: ["Looking up track...", "Now playing: **Track**"],
    });
  });

  it("updates the latest recent assistant memory in place", async () => {
    const updateMemory = vi.fn(async () => true);
    const runtime = {
      agentId: "agent-1" as UUID,
      getMemories: vi.fn(async () => [
        {
          id: "assistant-old",
          entityId: "agent-1",
          roomId: "room-1",
          createdAt: 3_000,
          content: {
            text: "Old reply",
          },
        },
        {
          id: "assistant-latest",
          entityId: "agent-1",
          roomId: "room-1",
          createdAt: 10_100,
          content: {
            text: "Now playing: **Track**",
            source: "action",
            actionCallbackHistory: ["Looking up track..."],
          },
        },
      ]),
      updateMemory,
    } as unknown as AgentRuntime;

    await expect(
      persistRecentAssistantActionCallbackHistory(
        runtime,
        "room-1" as UUID,
        [
          "Looking up track...",
          "Searching for track...",
          "Now playing: **Track**",
        ],
        10_000,
      ),
    ).resolves.toBe(true);

    expect(updateMemory).toHaveBeenCalledWith({
      id: "assistant-latest",
      content: {
        text: "Now playing: **Track**",
        source: "action",
        actionCallbackHistory: [
          "Looking up track...",
          "Searching for track...",
          "Now playing: **Track**",
        ],
      },
    });
  });

  it("returns false when there is no recent assistant memory to update", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      getMemories: vi.fn(async () => [
        {
          id: "user-1",
          entityId: "user-1",
          roomId: "room-1",
          createdAt: 10_100,
          content: {
            text: "hello",
          },
        },
      ]),
      updateMemory: vi.fn(async () => true),
    } as unknown as AgentRuntime;

    await expect(
      persistRecentAssistantActionCallbackHistory(
        runtime,
        "room-1" as UUID,
        ["Searching for track...", "Now playing: **Track**"],
        10_000,
      ),
    ).resolves.toBe(false);
  });
});
