/**
 * Pins X DM unread derivation in toInboxMessage/buildInbox: DMs the fetcher
 * already marked read (dm.readAt -> lastSeenAt) or replied (dm.repliedAt) must
 * not inflate x_dm unread counts, while never-seen DMs stay unread and chat
 * channels keep their unread-for-triage fallback (#22055). Deterministic —
 * pure aggregation over literal InboundMessage fixtures.
 */
import { describe, expect, it } from "vitest";

import { buildInbox } from "./aggregate";
import type { InboundMessage } from "./types";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function xDm(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    id: "dm1",
    source: "x_dm",
    senderName: "@friend",
    channelName: "X DM from @friend",
    channelType: "dm",
    text: "hey",
    snippet: "hey",
    timestamp: NOW - 60_000,
    threadId: "conv1",
    chatType: "dm",
    ...overrides,
  } as InboundMessage;
}

function build(messages: InboundMessage[]) {
  return buildInbox(messages, {
    limit: 100,
    allowed: new Set(["x_dm", "discord"]),
    sources: [],
    groupByThread: true,
  } as never);
}

describe("x_dm unread derivation", () => {
  it("counts a read-and-replied DM as read everywhere", () => {
    const inbox = build([
      xDm({
        lastSeenAt: new Date(NOW - 30_000).toISOString(),
        repliedAt: new Date(NOW - 20_000).toISOString(),
      }),
    ]);
    expect(inbox.messages[0]?.unread).toBe(false);
    expect(inbox.channelCounts.x_dm).toMatchObject({ total: 1, unread: 0 });
    expect(inbox.threadGroups?.[0]?.unreadCount).toBe(0);
  });

  it("read-only and replied-only DMs each count as read", () => {
    const readOnly = build([
      xDm({ lastSeenAt: new Date(NOW - 30_000).toISOString() }),
    ]);
    expect(readOnly.messages[0]?.unread).toBe(false);

    const repliedOnly = build([
      xDm({ id: "dm2", repliedAt: new Date(NOW - 20_000).toISOString() }),
    ]);
    expect(repliedOnly.messages[0]?.unread).toBe(false);
  });

  it("a never-seen DM stays unread", () => {
    const inbox = build([xDm({ id: "dm3" })]);
    expect(inbox.messages[0]?.unread).toBe(true);
    expect(inbox.channelCounts.x_dm).toMatchObject({ total: 1, unread: 1 });
  });

  it("chat channels keep the unread-for-triage fallback even with seen state", () => {
    const inbox = build([
      xDm({
        id: "c1",
        source: "discord",
        channelName: "general",
        lastSeenAt: new Date(NOW - 30_000).toISOString(),
      }),
    ]);
    expect(inbox.messages[0]?.unread).toBe(true);
  });

  describe("timestamp normalization", () => {
    it.each([
      ["NaN", Number.NaN],
      ["positive infinity", Number.POSITIVE_INFINITY],
      ["negative infinity", Number.NEGATIVE_INFINITY],
      ["finite but outside the Date range", Number.MAX_VALUE],
      ["missing", undefined],
      ["invalid string", "not-a-timestamp"],
      ["invalid object", {}],
    ])("maps %s to the safe epoch fallback", (_label, timestamp) => {
      const inbox = build([
        xDm({
          id: "dm-invalid",
          timestamp: timestamp as number,
        }),
      ]);

      expect(inbox.messages[0]?.receivedAt).toBe("1970-01-01T00:00:00.000Z");
    });

    it.each([
      [0, "1970-01-01T00:00:00.000Z"],
      [NOW, "2026-08-18T12:00:00.000Z"],
      [Date.parse("2026-08-18T07:00:00.000-05:00"), "2026-08-18T12:00:00.000Z"],
    ])("preserves valid epoch %s as %s", (timestamp, receivedAt) => {
      const inbox = build([xDm({ timestamp })]);

      expect(inbox.messages[0]?.receivedAt).toBe(receivedAt);
    });

    it("keeps an invalid timestamp behind a valid message in its thread", () => {
      const inbox = build([
        xDm({
          id: "dm-invalid",
          threadId: "conv-mixed",
          timestamp: Number.NaN,
        }),
        xDm({
          id: "dm-valid",
          threadId: "conv-mixed",
          timestamp: NOW,
        }),
      ]);
      expect(inbox.threadGroups).toHaveLength(1);
      expect(inbox.threadGroups?.[0]?.latestMessage.id).toBe("x_dm:dm-valid");
    });
  });
});
