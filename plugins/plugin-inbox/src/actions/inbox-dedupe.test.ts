/** INBOX keeps one row per real conversation, never per subject line. */
import { describe, expect, it } from "vitest";
import { dedupeAndOrder, type InboxItem } from "./inbox";

function gmail(
  id: string,
  receivedAt: string,
  threadKey: string,
  sender: string,
): InboxItem {
  return {
    id,
    platform: "gmail",
    channel: "INBOX",
    senderName: sender,
    snippet: `from ${sender}`,
    receivedAt,
    threadTopic: "Quick question",
    threadKey,
  };
}

describe("dedupeAndOrder", () => {
  it("keeps two senders' messages that share a subject", () => {
    const alice = gmail(
      "acctA:gmail:111",
      "2026-10-15T09:00:00Z",
      "acctA:t-alice",
      "Alice",
    );
    const bob = gmail(
      "acctB:gmail:222",
      "2026-10-15T10:00:00Z",
      "acctB:t-bob",
      "Bob",
    );
    expect(dedupeAndOrder([alice, bob]).map((item) => item.id)).toEqual([
      "acctB:gmail:222",
      "acctA:gmail:111",
    ]);
  });

  it("collapses one thread to its newest message", () => {
    const first = gmail(
      "acctA:gmail:1",
      "2026-10-15T09:00:00Z",
      "acctA:t-1",
      "Alice",
    );
    const reply = gmail(
      "acctA:gmail:2",
      "2026-10-15T09:30:00Z",
      "acctA:t-1",
      "Alice",
    );
    expect(dedupeAndOrder([first, reply]).map((item) => item.id)).toEqual([
      "acctA:gmail:2",
    ]);
  });

  it("keeps messages without a thread id apart", () => {
    const a = {
      ...gmail("x:1", "2026-10-15T09:00:00Z", "", "A"),
      threadKey: undefined,
    };
    const b = {
      ...gmail("x:2", "2026-10-15T09:01:00Z", "", "B"),
      threadKey: undefined,
    };
    expect(dedupeAndOrder([a, b])).toHaveLength(2);
  });
});
