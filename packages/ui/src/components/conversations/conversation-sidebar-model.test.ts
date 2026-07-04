/** Unit tests for `buildConversationsSidebarModel`: row shaping, time-bucketed sections, and source/world scope options over synthetic conversations + inbox chats (no rendering). */

import { describe, expect, it } from "vitest";
import type { Conversation } from "../../api/client-types-chat";
import type { TranslateFn } from "../../types";
import {
  ALL_CONNECTORS_SOURCE_SCOPE,
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
  ELIZA_SOURCE_SCOPE,
  type InboxChatSidebarRow,
  TERMINAL_SOURCE_SCOPE,
} from "./conversation-sidebar-model";

// Translate stub: return the supplied defaultValue (or the key) so section
// labels and scope options are assertable without the i18n catalog.
const t: TranslateFn = (key, options) =>
  (options?.defaultValue as string | undefined) ?? key;

const DAY_MS = 86_400_000;

function conv(overrides: Partial<Conversation> & { id: string }): Conversation {
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
  return {
    title: overrides.id,
    roomId: `room-${overrides.id}`,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

function inbox(
  overrides: Partial<InboxChatSidebarRow> & { id: string; source: string },
): InboxChatSidebarRow {
  return {
    lastMessageAt: Date.now(),
    title: overrides.id,
    worldLabel: "",
    ...overrides,
  };
}

function buildApp(conversations: Conversation[]) {
  return buildConversationsSidebarModel({
    conversations,
    inboxChats: [],
    searchQuery: "",
    sourceScope: ELIZA_SOURCE_SCOPE,
    t,
    worldScope: ALL_WORLDS_SCOPE,
  });
}

describe("buildConversationsSidebarModel — app (eliza) scope", () => {
  it("buckets conversations into Today / Yesterday / older time sections, newest-first", () => {
    const now = Date.now();
    const model = buildApp([
      conv({ id: "today", updatedAt: new Date(now).toISOString() }),
      conv({
        id: "yesterday",
        updatedAt: new Date(now - DAY_MS).toISOString(),
      }),
      conv({
        id: "lastweek",
        updatedAt: new Date(now - 9 * DAY_MS).toISOString(),
      }),
    ]);

    const labels = model.sections.map((s) => s.label);
    expect(labels).toEqual(["Today", "Yesterday", "Last week"]);
    // Flattened rows are ordered newest-first across sections.
    expect(model.rows.map((r) => r.id)).toEqual([
      "today",
      "yesterday",
      "lastweek",
    ]);
    expect(model.sections[0].count).toBe(1);
  });

  it("sorts conversations within a section newest-first", () => {
    const now = Date.now();
    const model = buildApp([
      conv({ id: "older", updatedAt: new Date(now - 1000).toISOString() }),
      conv({ id: "newer", updatedAt: new Date(now).toISOString() }),
    ]);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0].rows.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("hides page-scoped / automation conversations (non-main chats)", () => {
    const model = buildApp([
      conv({ id: "real" }),
      conv({ id: "settings-page", metadata: { scope: "page-settings" } }),
      conv({
        id: "automation",
        metadata: { scope: "automation-coordinator" },
      }),
    ]);
    expect(model.rows.map((r) => r.id)).toEqual(["real"]);
  });

  it("filters rows by the search query (case-insensitive, title substring)", () => {
    const model = buildConversationsSidebarModel({
      conversations: [
        conv({ id: "deploy", title: "Deploy incident" }),
        conv({ id: "billing", title: "Billing thread" }),
      ],
      inboxChats: [],
      searchQuery: "DEPLOY",
      sourceScope: ELIZA_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });
    expect(model.rows.map((r) => r.id)).toEqual(["deploy"]);
  });

  it("exposes Messages + Terminal source options and falls back to eliza scope when unknown", () => {
    const model = buildConversationsSidebarModel({
      conversations: [conv({ id: "a" })],
      inboxChats: [],
      searchQuery: "",
      sourceScope: "no-such-scope",
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });
    const optionValues = model.sourceOptions.map((o) => o.value);
    expect(optionValues).toContain(ELIZA_SOURCE_SCOPE);
    expect(optionValues).toContain(TERMINAL_SOURCE_SCOPE);
    // Unknown requested scope is normalized back to the app (eliza) scope.
    expect(model.sourceScope).toBe(ELIZA_SOURCE_SCOPE);
  });
});

describe("buildConversationsSidebarModel — connector scope", () => {
  it("includes the All-connectors option once connector rows exist", () => {
    const model = buildConversationsSidebarModel({
      conversations: [],
      inboxChats: [
        inbox({
          id: "d1",
          source: "discord",
          worldId: "guild-1",
          worldLabel: "Acme Guild",
        }),
      ],
      searchQuery: "",
      sourceScope: ELIZA_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });
    expect(model.sourceOptions.map((o) => o.value)).toContain(
      ALL_CONNECTORS_SOURCE_SCOPE,
    );
  });

  it("scopes rows to the requested connector source and surfaces world options", () => {
    const model = buildConversationsSidebarModel({
      conversations: [],
      inboxChats: [
        inbox({
          id: "d1",
          source: "discord",
          worldId: "guild-1",
          worldLabel: "Acme Guild",
        }),
        inbox({
          id: "t1",
          source: "telegram",
          worldId: "chat-1",
          worldLabel: "Friends",
        }),
      ],
      searchQuery: "",
      sourceScope: "discord",
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });
    // Only the discord chat is in scope.
    expect(model.rows.map((r) => r.id)).toEqual(["d1"]);
    expect(model.showWorldFilter).toBe(true);
    // World options include the "All" pseudo-option plus the named world.
    const worldLabels = model.worldOptions.map((o) => o.label);
    expect(worldLabels).toContain("Acme Guild");
  });

  it("treats DM-like rooms (no world / DM roomType) as the DMs world", () => {
    const model = buildConversationsSidebarModel({
      conversations: [],
      inboxChats: [
        inbox({ id: "dm1", source: "discord", roomType: "DM" }),
        inbox({
          id: "guild1",
          source: "discord",
          worldId: "guild-1",
          worldLabel: "Acme Guild",
        }),
      ],
      searchQuery: "",
      sourceScope: ALL_CONNECTORS_SOURCE_SCOPE,
      t,
      worldScope: ALL_WORLDS_SCOPE,
    });
    const dmRow = model.rows.find((r) => r.id === "dm1");
    expect(dmRow?.worldLabel).toBe("DMs");
  });
});
