/**
 * Undated inbox rows sort after dated ones and must not render the epoch date.
 */

import type { TranslateFn } from "@elizaos/contracts";
import { expect, it } from "vitest";
import {
  ALL_CONNECTORS_SOURCE_SCOPE,
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
  type InboxChatSidebarRow,
} from "./conversation-sidebar-model";

const t: TranslateFn = (_key, options) =>
  typeof options?.defaultValue === "string" ? options.defaultValue : _key;

function inboxChat(
  overrides: Partial<InboxChatSidebarRow> & Pick<InboxChatSidebarRow, "id">,
): InboxChatSidebarRow {
  return {
    lastMessageAt: Date.now(),
    source: "gmail",
    title: overrides.id,
    worldLabel: "Inbox",
    ...overrides,
  };
}

it("labels an undated inbox chat as undated and sorts it after dated chats", () => {
  const model = buildConversationsSidebarModel({
    conversations: [],
    inboxChats: [
      inboxChat({ id: "dated", lastMessageAt: Date.now(), title: "Dated" }),
      inboxChat({
        id: "undated",
        lastMessageAt: Number.NaN,
        title: "Undated",
      }),
    ],
    searchQuery: "",
    sourceScope: ALL_CONNECTORS_SOURCE_SCOPE,
    t,
    worldScope: ALL_WORLDS_SCOPE,
  });

  const rows = model.sections.flatMap((section) => section.rows);
  expect(rows.map((row) => row.id)).toEqual(["dated", "undated"]);
  const undated = rows[1];
  expect(undated?.updatedAtLabel).toBe("No date");
  expect(undated?.updatedAtLabel).not.toContain("1970");
  expect(model.sections.at(-1)?.label).toBe("No date");
});

it("keeps undated inbox rows behind dated rows without inventing a 1970 label", () => {
  const model = buildConversationsSidebarModel({
    conversations: [],
    searchQuery: "",
    sourceScope: ALL_CONNECTORS_SOURCE_SCOPE,
    worldScope: ALL_WORLDS_SCOPE,
    t: (key, options) => String(options?.defaultValue ?? key),
    inboxChats: [
      {
        id: "unknown",
        title: "Unknown",
        source: "discord",
        worldLabel: "Direct messages",
        lastMessageAt: Number.NaN,
      },
      {
        id: "dated",
        title: "Dated",
        source: "discord",
        worldLabel: "Direct messages",
        lastMessageAt: Date.now() - 60000,
      },
    ],
  });
  expect(model.rows.map((row) => row.id)).toEqual(["dated", "unknown"]);
  expect(model.rows[1].updatedAtLabel).toBe("No date");
  expect(model.rows[1].sortKey).toBe(0);
});
