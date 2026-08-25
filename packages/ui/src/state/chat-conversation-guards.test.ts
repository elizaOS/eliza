/**
 * Covers the predicates that decide which conversations reach the main chat
 * transcript list.
 *
 * The load-bearing case is the legacy page-chat heuristic. A scope-less
 * conversation whose title is one of a reserved set is treated as a legacy page
 * chat and hidden from every list — which is why renaming a chat to "wallet"
 * once made it vanish with no recovery path. `isReservedLegacyChatTitle` is the
 * guard that rename validation uses to refuse those titles, so the two must
 * agree exactly: any title the guard rejects must be a title the filter would
 * have hidden.
 *
 * Pure predicates — no React, no API.
 */
import { describe, expect, it } from "vitest";

import type { Conversation } from "../api";
import {
  filterMainChatConversations,
  isConversationRecord,
  isMainChatConversation,
  isReservedLegacyChatTitle,
  normalizeConversationList,
} from "./chat-conversation-guards.ts";

const RESERVED = [
  "browser",
  "character",
  "automations",
  "apps",
  "phone",
  "settings",
  "wallet",
];

const conversation = (overrides: Partial<Conversation> = {}): Conversation =>
  ({
    id: "c1",
    title: "A chat",
    roomId: "r1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as Conversation;

describe("isReservedLegacyChatTitle", () => {
  it("rejects every reserved title, case- and whitespace-insensitively", () => {
    for (const title of RESERVED) {
      expect(isReservedLegacyChatTitle(title)).toBe(true);
      expect(isReservedLegacyChatTitle(title.toUpperCase())).toBe(true);
      expect(isReservedLegacyChatTitle(`  ${title}  `)).toBe(true);
    }
  });

  it("allows ordinary titles, including ones merely containing a reserved word", () => {
    for (const title of [
      "my wallet",
      "wallet stuff",
      "settings for x",
      "",
      "notes",
    ]) {
      expect(isReservedLegacyChatTitle(title)).toBe(false);
    }
  });

  it("agrees with the filter: every rejected title would have been hidden", () => {
    // This is the invariant that keeps rename validation and the list filter
    // from drifting apart.
    for (const title of RESERVED) {
      expect(isReservedLegacyChatTitle(title)).toBe(true);
      expect(isMainChatConversation({ title, metadata: undefined })).toBe(
        false,
      );
    }
  });
});

describe("isMainChatConversation", () => {
  it("keeps an ordinary scope-less conversation", () => {
    expect(
      isMainChatConversation({ title: "My chat", metadata: undefined }),
    ).toBe(true);
  });

  it("keeps a conversation with no title at all", () => {
    expect(isMainChatConversation({ title: "", metadata: undefined })).toBe(
      true,
    );
    expect(isMainChatConversation({ metadata: undefined } as never)).toBe(true);
  });

  it("hides a scope-less conversation whose title collides with a page name", () => {
    expect(
      isMainChatConversation({ title: "Wallet", metadata: undefined }),
    ).toBe(false);
  });

  it("keeps a reserved title once the conversation carries an explicit scope", () => {
    // New conversations are stamped scope:"general" at creation, which is what
    // makes the title heuristic apply only to the pre-stamp backlog.
    expect(
      isMainChatConversation({
        title: "wallet",
        metadata: { scope: "general" },
      } as never),
    ).toBe(true);
  });

  it("hides every automation scope", () => {
    for (const scope of [
      "automation-coordinator",
      "automation-workflow",
      "automation-workflow-draft",
      "automation-draft",
    ]) {
      expect(
        isMainChatConversation({ title: "x", metadata: { scope } } as never),
      ).toBe(false);
    }
  });

  it("hides any page-scoped conversation by prefix", () => {
    for (const scope of ["page-browser", "page-anything", "page-"]) {
      expect(
        isMainChatConversation({ title: "x", metadata: { scope } } as never),
      ).toBe(false);
    }
  });

  it("keeps an unrecognized scope rather than hiding it", () => {
    expect(
      isMainChatConversation({
        title: "x",
        metadata: { scope: "custom" },
      } as never),
    ).toBe(true);
  });

  it("treats a null or undefined conversation as not hidden", () => {
    expect(isMainChatConversation(null)).toBe(true);
    expect(isMainChatConversation(undefined)).toBe(true);
  });
});

describe("isConversationRecord", () => {
  it("accepts a complete record", () => {
    expect(isConversationRecord(conversation())).toBe(true);
  });

  it("rejects a record missing any required field", () => {
    for (const field of ["id", "title", "roomId", "createdAt", "updatedAt"]) {
      const partial = { ...conversation() } as Record<string, unknown>;
      delete partial[field];
      expect(isConversationRecord(partial)).toBe(false);
    }
  });

  it("rejects a blank or non-string id", () => {
    expect(isConversationRecord({ ...conversation(), id: "   " })).toBe(false);
    expect(isConversationRecord({ ...conversation(), id: 42 })).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "x", 42, []]) {
      expect(isConversationRecord(value)).toBe(false);
    }
  });

  it("accepts an empty title, which is a legal conversation state", () => {
    expect(isConversationRecord({ ...conversation(), title: "" })).toBe(true);
  });
});

describe("filterMainChatConversations / normalizeConversationList", () => {
  it("filters hidden conversations out of a list", () => {
    const kept = filterMainChatConversations([
      conversation({ id: "keep", title: "Real chat" }),
      conversation({ id: "hide", title: "wallet" }),
    ]);
    expect(kept.map((c) => c.id)).toEqual(["keep"]);
  });

  it("drops malformed entries before filtering", () => {
    const list = normalizeConversationList([
      conversation({ id: "keep" }),
      { id: "broken" },
      null,
      "nonsense",
      conversation({ id: "hidden", title: "settings" }),
    ]);
    expect(list.map((c) => c.id)).toEqual(["keep"]);
  });

  it("returns an empty list for non-array input", () => {
    for (const value of [null, undefined, {}, "x"]) {
      expect(normalizeConversationList(value)).toEqual([]);
    }
  });
});
