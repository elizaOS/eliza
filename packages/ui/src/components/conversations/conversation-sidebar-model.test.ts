import { expect, it } from "vitest";
import {
  ALL_CONNECTORS_SOURCE_SCOPE,
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
} from "./conversation-sidebar-model";

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
  expect(model.rows[1].updatedAtLabel).toBe("");
  expect(model.rows[1].sortKey).toBe(0);
});
