import { describe, expect, it } from "vitest";
import type { Conversation } from "../api/client-types-chat";
import {
  isMainChatConversation,
  normalizeConversationList,
} from "./chat-conversation-guards";

function makeConversation(
  id: string,
  metadata?: Conversation["metadata"],
): Conversation {
  return {
    id,
    title: id,
    roomId: `room-${id}`,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    metadata,
  };
}

describe("chat-conversation-guards", () => {
  it("treats page-scoped and automation conversations as hidden from main chat", () => {
    expect(
      isMainChatConversation(makeConversation("page", { scope: "page-apps" })),
    ).toBe(false);
    expect(
      isMainChatConversation(makeConversation("legacy-page", undefined)),
    ).toBe(true);
    expect(
      isMainChatConversation(
        makeConversation("automation", {
          scope: "automation-workflow",
        }),
      ),
    ).toBe(false);
    expect(isMainChatConversation(makeConversation("main"))).toBe(true);
  });

  it("hides legacy unscoped page-title conversations from main chat", () => {
    expect(
      isMainChatConversation({
        ...makeConversation("legacy"),
        title: "Settings",
      }),
    ).toBe(false);
  });

  it("normalizes to only main-chat conversations", () => {
    const conversations = normalizeConversationList([
      makeConversation("main"),
      makeConversation("page", { scope: "page-settings" }),
      makeConversation("automation", { scope: "automation-draft" }),
    ]);

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      "main",
    ]);
  });
});
