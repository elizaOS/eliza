import { describe, expect, it } from "vitest";
import type { Conversation } from "../../api/client-types-chat";
import {
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
  ELIZA_SOURCE_SCOPE,
  type InboxChatSidebarRow,
} from "./conversation-sidebar-model";

// Passthrough translate fn: return the provided defaultValue (or the key) so the
// model's labels are deterministic without an i18n catalog.
const t = ((key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key) as Parameters<
  typeof buildConversationsSidebarModel
>[0]["t"];

function conversation(over: Partial<Conversation>): Conversation {
  return {
    id: "c1",
    title: "Hello world",
    roomId: "r1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function inboxChat(over: Partial<InboxChatSidebarRow>): InboxChatSidebarRow {
  return {
    id: "i1",
    title: "Inbox chat",
    source: "discord",
    lastMessageAt: 1_700_000_000_000,
    worldLabel: "DMs",
    ...over,
  };
}

function build(args: {
  conversations?: Conversation[];
  inboxChats?: InboxChatSidebarRow[];
  searchQuery?: string;
  sourceScope?: string;
  worldScope?: string;
}) {
  return buildConversationsSidebarModel({
    conversations: args.conversations ?? [],
    inboxChats: args.inboxChats ?? [],
    searchQuery: args.searchQuery ?? "",
    sourceScope: args.sourceScope ?? ELIZA_SOURCE_SCOPE,
    worldScope: args.worldScope ?? ALL_WORLDS_SCOPE,
    t,
  });
}

describe("buildConversationsSidebarModel", () => {
  it("returns an empty, well-formed model for empty inputs", () => {
    const model = build({});
    expect(model.rows).toHaveLength(0);
    expect(model.sections).toHaveLength(0);
    expect(model.sourceScope).toBe(ELIZA_SOURCE_SCOPE);
    expect(model.worldScope).toBe(ALL_WORLDS_SCOPE);
    expect(model.showWorldFilter).toBe(false);
  });

  it("lists app conversations newest-first under the eliza scope", () => {
    const model = build({
      conversations: [
        conversation({ id: "old", title: "Older", updatedAt: "2026-01-01T00:00:00.000Z" }),
        conversation({ id: "new", title: "Newer", updatedAt: "2026-02-01T00:00:00.000Z" }),
      ],
    });
    expect(model.rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(model.rows.every((r) => r.kind === "conversation")).toBe(true);
  });

  it("filters rows by a case-insensitive title search", () => {
    const model = build({
      conversations: [
        conversation({ id: "a", title: "Budget review" }),
        conversation({ id: "b", title: "Dentist" }),
      ],
      searchQuery: "BUDGET",
    });
    expect(model.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("falls back to the eliza scope when the requested source is unavailable", () => {
    const model = build({
      conversations: [conversation({ id: "a" })],
      sourceScope: "__not_a_real_source__",
    });
    expect(model.sourceScope).toBe(ELIZA_SOURCE_SCOPE);
  });

  it("surfaces connector inbox chats as their own source option", () => {
    const model = build({
      inboxChats: [
        inboxChat({ id: "d1", source: "discord", title: "Discord DM" }),
      ],
    });
    const values = model.sourceOptions.map((o) => o.value);
    // The eliza scope is always present; the connector source is added.
    expect(values).toContain(ELIZA_SOURCE_SCOPE);
    const connector = model.sourceOptions.find(
      (o) => o.value !== ELIZA_SOURCE_SCOPE && o.value.length > 0,
    );
    expect(connector).toBeDefined();
  });

  it("shows the world filter for a connector source with a named world", () => {
    const chats = [
      inboxChat({
        id: "g1",
        source: "discord",
        title: "Guild chat",
        roomType: "GROUP",
        worldId: "w1",
        worldLabel: "Acme Guild",
      }),
    ];
    // Discover the connector source key the model assigned, then scope to it.
    const scoped = build({ inboxChats: chats, sourceScope: "__all_connectors__" });
    const connectorRow = scoped.rows.find((r) => r.kind === "inbox");
    expect(connectorRow).toBeDefined();
    const sourceKey = connectorRow?.sourceKey ?? "";

    const model = build({ inboxChats: chats, sourceScope: sourceKey });
    expect(model.showWorldFilter).toBe(true);
    expect(model.worldOptions.some((o) => o.label === "Acme Guild")).toBe(true);
  });

  it("treats a DM-like connector chat as not contributing a world filter", () => {
    const model = build({
      inboxChats: [
        inboxChat({ id: "dm1", source: "discord", roomType: "DM", worldLabel: "DMs" }),
      ],
      sourceScope: "__all_connectors__",
    });
    // A DM has no real world, so no world filter is offered.
    expect(model.showWorldFilter).toBe(false);
    expect(model.worldScope).toBe(ALL_WORLDS_SCOPE);
  });
});
