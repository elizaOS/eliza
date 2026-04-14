import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  buildPersistedAssistantContent,
  formatConversationMessageText,
  persistRecentAssistantActionCallbackHistory,
} from "./conversation-routes.js";

describe("conversation callback history persistence", () => {
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
