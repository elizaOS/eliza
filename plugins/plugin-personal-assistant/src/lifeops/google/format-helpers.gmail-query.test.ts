import { describe, expect, it } from "vitest";
import { formatEmailSearch } from "./format-helpers.ts";

describe("formatEmailSearch quoted Gmail operators", () => {
  it("keeps a quoted multi-word sender together", () => {
    const text = formatEmailSearch({
      query: 'from:"Ada Lovelace" is:unread',
      messages: [],
      source: "cache",
      syncedAt: null,
      summary: {
        totalCount: 0,
        unreadCount: 0,
        importantCount: 0,
        replyNeededCount: 0,
      },
    });

    expect(text).toBe(
      'No email matched sender "Ada Lovelace" that are unread.',
    );
  });
});
