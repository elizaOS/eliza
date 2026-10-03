/**
 * Owner conversation selection and ambient delivery take the first row from
 * compareConversationsByRecency. A same-timestamp tie must keep the higher UUID.
 */
import { describe, expect, it } from "vitest";
import { compareConversationsByRecency } from "../src/api/conversation-sort.ts";

const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPPER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SAME = "2026-08-20T16:00:00.000Z";

describe("conversation recency UUID ties", () => {
  it("orders the higher UUID first when updatedAt matches", () => {
    const ordered = [
      { id: LOWER, updatedAt: SAME },
      { id: UPPER, updatedAt: SAME },
    ].sort(compareConversationsByRecency);

    expect(ordered.map((conversation) => conversation.id)).toEqual([
      UPPER,
      LOWER,
    ]);
  });
});
