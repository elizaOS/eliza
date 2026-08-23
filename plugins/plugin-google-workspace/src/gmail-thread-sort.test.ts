/**
 * Unit tests for Google Workspace Gmail thread message sorting.
 */
import { describe, expect, it } from "vitest";
import { compareUnrespondedThreads, sortGmailMessages } from "./gmail.js";
import type { GoogleGmailMessageSummary, GoogleGmailUnrespondedThread } from "./types.js";

describe("Gmail thread message safe date sorting", () => {
  it("maintains strict total ordering when receivedAt contains invalid date strings", () => {
    const messages: Pick<GoogleGmailMessageSummary, "externalId" | "receivedAt" | "isImportant" | "likelyReplyNeeded" | "isUnread">[] = [
      {
        externalId: "msg-valid-older",
        receivedAt: "2026-05-01T10:00:00.000Z",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      },
      {
        externalId: "msg-invalid",
        receivedAt: "invalid-date-string",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      },
      {
        externalId: "msg-valid-newer",
        receivedAt: "2026-05-01T12:00:00.000Z",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      },
    ] as unknown as GoogleGmailMessageSummary[];

    const sorted = sortGmailMessages(messages as GoogleGmailMessageSummary[]);

    expect(sorted).toHaveLength(3);
    expect(sorted[0]?.externalId).toBe("msg-invalid");
    expect(sorted[1]?.externalId).toBe("msg-valid-older");
    expect(sorted[2]?.externalId).toBe("msg-valid-newer");
  });

  it("maintains strict total ordering when daysWaiting contains NaN or non-finite numbers", () => {
    const threads: GoogleGmailUnrespondedThread[] = [
      { threadId: "thread-nan", daysWaiting: NaN, externalMessageId: "m1", subject: "s", to: [], cc: [], lastOutboundAt: "", lastInboundAt: null, snippet: "", labels: [], htmlLink: null },
      { threadId: "thread-high", daysWaiting: 15, externalMessageId: "m2", subject: "s", to: [], cc: [], lastOutboundAt: "", lastInboundAt: null, snippet: "", labels: [], htmlLink: null },
      { threadId: "thread-low", daysWaiting: 2, externalMessageId: "m3", subject: "s", to: [], cc: [], lastOutboundAt: "", lastInboundAt: null, snippet: "", labels: [], htmlLink: null },
    ];

    threads.sort(compareUnrespondedThreads);

    expect(threads[0]?.threadId).toBe("thread-high");
    expect(threads[1]?.threadId).toBe("thread-low");
    expect(threads[2]?.threadId).toBe("thread-nan");
  });

  it("tie-breaks threads with same daysWaiting deterministically by threadId", () => {
    const threads: GoogleGmailUnrespondedThread[] = [
      { threadId: "z-thread", daysWaiting: 5, externalMessageId: "m1", subject: "s", to: [], cc: [], lastOutboundAt: "", lastInboundAt: null, snippet: "", labels: [], htmlLink: null },
      { threadId: "a-thread", daysWaiting: 5, externalMessageId: "m2", subject: "s", to: [], cc: [], lastOutboundAt: "", lastInboundAt: null, snippet: "", labels: [], htmlLink: null },
    ];

    threads.sort(compareUnrespondedThreads);

    expect(threads[0]?.threadId).toBe("a-thread");
    expect(threads[1]?.threadId).toBe("z-thread");
  });
});
