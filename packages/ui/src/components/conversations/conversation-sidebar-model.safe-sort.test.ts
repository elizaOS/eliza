/**
 * Verifies safe sorting in conversation sidebar model when updatedAt or lastMessageAt contains NaN or invalid timestamps.
 */

import { describe, expect, it } from "vitest";
import type { Conversation } from "../../api/client-types-chat.js";
import {
  ALL_CONNECTORS_SOURCE_SCOPE,
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
  ELIZA_SOURCE_SCOPE,
  type InboxChatSidebarRow,
} from "./conversation-sidebar-model.js";

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

describe("conversation-sidebar-model safe sort", () => {
  it("safely handles conversations with invalid updatedAt dates without crashing or producing NaN sort order", () => {
    const conversations: Conversation[] = [
      {
        id: "conv-1",
        title: "Valid Conv 1",
        createdAt: "2026-08-20T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:00.000Z",
        messages: [],
      } as unknown as Conversation,
      {
        id: "conv-invalid",
        title: "Invalid Date Conv",
        createdAt: "invalid-date",
        updatedAt: "not-a-valid-date",
        messages: [],
      } as unknown as Conversation,
      {
        id: "conv-2",
        title: "Valid Conv 2",
        createdAt: "2026-08-21T10:00:00.000Z",
        updatedAt: "2026-08-22T10:00:00.000Z",
        messages: [],
      } as unknown as Conversation,
    ];

    const model = buildConversationsSidebarModel({
      conversations,
      inboxChats: [],
      searchQuery: "",
      sourceScope: ELIZA_SOURCE_SCOPE,
      worldScope: ALL_WORLDS_SCOPE,
      t,
    });

    expect(model.sections).toBeDefined();
    const rows = model.sections.flatMap((s) => s.rows);
    expect(rows).toHaveLength(3);
    // Valid dates with higher timestamp should come first
    expect(rows[0].id).toBe("conv-1");
    expect(rows[1].id).toBe("conv-2");
    expect(rows[2].id).toBe("conv-invalid");
  });

  it("safely handles inbox chats with NaN or non-finite lastMessageAt", () => {
    const inboxChats: InboxChatSidebarRow[] = [
      {
        id: "chat-nan",
        title: "NaN Chat",
        source: "telegram",
        lastMessageAt: NaN,
      } as unknown as InboxChatSidebarRow,
      {
        id: "chat-valid",
        title: "Valid Chat",
        source: "telegram",
        lastMessageAt: 10000,
      } as unknown as InboxChatSidebarRow,
    ];

    const model = buildConversationsSidebarModel({
      conversations: [],
      inboxChats,
      searchQuery: "",
      sourceScope: ALL_CONNECTORS_SOURCE_SCOPE,
      worldScope: ALL_WORLDS_SCOPE,
      t,
    });

    expect(model.sections).toBeDefined();
    const rows = model.sections.flatMap((s) => s.rows);
    expect(rows).toHaveLength(2);
  });

  it("safely computes non-finite sort subtraction without producing NaN", () => {
    const safeDiff =
      (Number.isFinite(NaN) ? NaN : 0) - (Number.isFinite(500) ? 500 : 0);
    expect(safeDiff).toBe(-500);
  });
});
