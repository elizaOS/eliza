import { describe, expect, it } from "vitest";
import type { Conversation } from "../../api/client-types-chat";
import {
  ALL_CONNECTORS_SOURCE_SCOPE,
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
  ELIZA_SOURCE_SCOPE,
  type InboxChatSidebarRow,
  TERMINAL_SOURCE_SCOPE,
} from "./conversation-sidebar-model";

const t = (key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key;

function makeConversation(
  id: string,
  updatedAt = "2026-04-20T00:00:00.000Z",
): Conversation {
  return {
    id,
    title: `Conv ${id}`,
    createdAt: updatedAt,
    updatedAt,
  } as Conversation;
}

function makeInboxRow(
  id: string,
  overrides: Partial<InboxChatSidebarRow> = {},
): InboxChatSidebarRow {
  return {
    id,
    source: "discord",
    lastMessageAt: 1_700_000_000_000,
    title: `Inbox ${id}`,
    worldLabel: "Guild",
    worldId: "world-1",
    ...overrides,
  };
}

describe("buildConversationsSidebarModel — Terminal channel", () => {
  it("always includes the Terminal scope in sourceOptions", () => {
    const model = buildConversationsSidebarModel({
      conversations: [],
      inboxChats: [],
      searchQuery: "",
      sourceScope: ELIZA_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });

    const values = model.sourceOptions.map((o) => o.value);
    expect(values).toContain(ELIZA_SOURCE_SCOPE);
    expect(values).toContain(TERMINAL_SOURCE_SCOPE);
  });

  it("Terminal scope option sits immediately after Messages", () => {
    const model = buildConversationsSidebarModel({
      conversations: [makeConversation("c1")],
      inboxChats: [makeInboxRow("d1")],
      searchQuery: "",
      sourceScope: ELIZA_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });

    const values = model.sourceOptions.map((o) => o.value);
    expect(values.indexOf(TERMINAL_SOURCE_SCOPE)).toBe(
      values.indexOf(ELIZA_SOURCE_SCOPE) + 1,
    );
  });

  it("Terminal scope returns no conversation rows (rows are injected by the sidebar)", () => {
    const model = buildConversationsSidebarModel({
      conversations: [makeConversation("c1"), makeConversation("c2")],
      inboxChats: [makeInboxRow("d1")],
      searchQuery: "",
      sourceScope: TERMINAL_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });

    expect(model.sourceScope).toBe(TERMINAL_SOURCE_SCOPE);
    expect(model.rows).toHaveLength(0);
    expect(model.sections).toHaveLength(0);
  });

  it("Terminal scope disables the world filter", () => {
    const model = buildConversationsSidebarModel({
      conversations: [],
      inboxChats: [makeInboxRow("d1")],
      searchQuery: "",
      sourceScope: TERMINAL_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });

    expect(model.showWorldFilter).toBe(false);
    expect(model.worldOptions).toHaveLength(0);
  });

  it("keeps Messages scope behaviour untouched when connectors exist", () => {
    const model = buildConversationsSidebarModel({
      conversations: [makeConversation("c1")],
      inboxChats: [makeInboxRow("d1")],
      searchQuery: "",
      sourceScope: ELIZA_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });

    // One conversation row rendered, connectors still listed in the source
    // rail alongside the All connectors aggregate.
    expect(model.rows.some((row) => row.id === "c1")).toBe(true);
    const values = model.sourceOptions.map((o) => o.value);
    expect(values).toContain(ALL_CONNECTORS_SOURCE_SCOPE);
    expect(values).toContain("discord");
  });
});
