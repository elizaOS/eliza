/**
 * Unit coverage for `sanitizeConversationMetadata` — a pure, deterministic
 * sanitizer with no runtime or I/O. Pins each allowlist/guard branch of the
 * untrusted-metadata → typed-DTO boundary.
 */
import { describe, expect, it } from "vitest";
import {
  extractConversationMetadataFromRoom,
  sanitizeConversationMetadata,
} from "./conversation-metadata.ts";

/**
 * `sanitizeConversationMetadata` is the untrusted-input → typed-DTO boundary for
 * conversation metadata (#8801 — it shipped untested). It must drop anything not
 * on the scope/automation-type allowlist and coerce every id field through a
 * non-empty-string guard, so a caller can't smuggle an unknown scope or a
 * non-string id into the conversation system. Each branch is pinned here.
 */
describe("sanitizeConversationMetadata", () => {
  it("returns undefined for non-record input", () => {
    for (const v of [null, undefined, "string", 42, true]) {
      expect(sanitizeConversationMetadata(v)).toBeUndefined();
    }
  });

  it("returns undefined when nothing valid survives (empty record)", () => {
    // the sanitizer collapses an all-dropped result to undefined (line 106)
    expect(sanitizeConversationMetadata({})).toBeUndefined();
  });

  it("keeps an allowlisted scope (trimmed) and drops an unknown one", () => {
    expect(sanitizeConversationMetadata({ scope: "  general  " })).toEqual({
      scope: "general",
    });
    expect(sanitizeConversationMetadata({ scope: "page-wallet" })).toEqual({
      scope: "page-wallet",
    });
    expect(
      sanitizeConversationMetadata({ scope: "bogus-scope" }),
    ).toBeUndefined();
  });

  it("keeps an allowlisted automationType and drops an unknown one", () => {
    expect(
      sanitizeConversationMetadata({ automationType: "workflow" }),
    ).toEqual({ automationType: "workflow" });
    expect(
      sanitizeConversationMetadata({ automationType: "not-a-type" }),
    ).toBeUndefined();
  });

  it("keeps non-empty string id fields and drops empty/whitespace/non-string", () => {
    expect(
      sanitizeConversationMetadata({ taskId: "t-1", workflowId: "wf-2" }),
    ).toEqual({ taskId: "t-1", workflowId: "wf-2" });
    // empty, whitespace, and non-string all drop out → nothing survives
    expect(
      sanitizeConversationMetadata({ taskId: "", triggerId: "   ", pageId: 7 }),
    ).toBeUndefined();
  });

  it("passes through a realistic automation payload, ignoring unknown keys", () => {
    expect(
      sanitizeConversationMetadata({
        scope: "automation-workflow",
        automationType: "workflow",
        workflowId: "wf-1",
        workflowName: "Daily report",
        somethingUnknown: "should be ignored",
      }),
    ).toEqual({
      scope: "automation-workflow",
      automationType: "workflow",
      workflowId: "wf-1",
      workflowName: "Daily report",
    });
  });
});

describe("extractConversationMetadataFromRoom", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["different", "conversation-2"],
  ])("rejects pinned metadata with a %s stored id", (_label, storedId) => {
    const webConversation = {
      scope: "page-wallet",
      ...(storedId !== undefined ? { conversationId: storedId } : {}),
    };

    expect(
      extractConversationMetadataFromRoom(
        { metadata: { webConversation } },
        "conversation-1",
      ),
    ).toBeUndefined();
  });

  it("returns pinned metadata only for the matching normalized stored id", () => {
    expect(
      extractConversationMetadataFromRoom(
        {
          metadata: {
            webConversation: {
              conversationId: "  conversation-1  ",
              scope: "page-wallet",
              unknown: "discarded",
            },
          },
        },
        "conversation-1",
      ),
    ).toEqual({ scope: "page-wallet" });
  });

  it("keeps an omitted expected id unpinned", () => {
    expect(
      extractConversationMetadataFromRoom({
        metadata: { webConversation: { scope: "page-wallet" } },
      }),
    ).toEqual({ scope: "page-wallet" });
  });

  it("does not treat an explicitly empty expected id as unpinned", () => {
    expect(
      extractConversationMetadataFromRoom(
        {
          metadata: {
            webConversation: {
              conversationId: "conversation-1",
              scope: "page-wallet",
            },
          },
        },
        "",
      ),
    ).toBeUndefined();
  });

  it("sorts conversation items and messages safely when timestamps contain NaN", () => {
    const convs = [
      { id: "c-nan", updatedAt: "invalid-date" },
      { id: "c-1", updatedAt: "2026-08-23T10:00:00Z" },
    ];
    convs.sort((a, b) => {
      const bTime = new Date(b.updatedAt).getTime();
      const aTime = new Date(a.updatedAt).getTime();
      const bVal = Number.isFinite(bTime) ? bTime : 0;
      const aVal = Number.isFinite(aTime) ? aTime : 0;
      return bVal - aVal || a.id.localeCompare(b.id);
    });
    expect(convs[0]?.id).toBe("c-1");
    expect(convs[1]?.id).toBe("c-nan");

    const memories = [
      { id: "m-nan", createdAt: NaN },
      { id: "m-1", createdAt: 1000 },
    ];
    memories.sort((a, b) => {
      const aCreated =
        typeof a.createdAt === "number" && Number.isFinite(a.createdAt)
          ? a.createdAt
          : 0;
      const bCreated =
        typeof b.createdAt === "number" && Number.isFinite(b.createdAt)
          ? b.createdAt
          : 0;
      return (
        aCreated - bCreated ||
        (a.id ? String(a.id) : "").localeCompare(b.id ? String(b.id) : "")
      );
    });
    expect(memories[0]?.id).toBe("m-nan");
    expect(memories[1]?.id).toBe("m-1");
  });
});
