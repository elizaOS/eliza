/**
 * Unit tests for the Gmail unresponded-thread and message sort comparators
 * exported by `gmail.ts`. Deterministic and mock-free: each case calls the
 * production comparator directly with fixtures whose ordering is fully
 * determined by the guarded arithmetic and the id tiebreakers.
 */
import { describe, expect, it } from "vitest";
import { compareUnrespondedThreads, sortGmailMessages } from "./gmail.js";
import type { GoogleGmailMessageSummary, GoogleGmailUnrespondedThread } from "./types.js";

function makeMessage(
  overrides: Partial<GoogleGmailMessageSummary> & Pick<GoogleGmailMessageSummary, "externalId">
): GoogleGmailMessageSummary {
  return {
    threadId: "thread-1",
    subject: "subject",
    from: "Sender",
    fromEmail: "sender@example.com",
    replyTo: null,
    to: [],
    cc: [],
    snippet: "",
    receivedAt: "2026-05-01T10:00:00.000Z",
    isUnread: false,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 0,
    triageReason: "",
    labels: [],
    htmlLink: null,
    metadata: {},
    ...overrides,
  };
}

function makeThread(threadId: string, daysWaiting: number): GoogleGmailUnrespondedThread {
  return {
    threadId,
    externalMessageId: `${threadId}-message`,
    subject: "subject",
    to: [],
    cc: [],
    lastOutboundAt: "2026-05-01T10:00:00.000Z",
    lastInboundAt: null,
    daysWaiting,
    snippet: "",
    labels: [],
    htmlLink: null,
  };
}

describe("compareUnrespondedThreads", () => {
  it("keeps a non-finite daysWaiting from poisoning the ordering", () => {
    const threads = [
      makeThread("thread-nan", Number.NaN),
      makeThread("thread-high", 15),
      makeThread("thread-low", 2),
    ];

    threads.sort(compareUnrespondedThreads);

    expect(threads.map((thread) => thread.threadId)).toEqual([
      "thread-high",
      "thread-low",
      "thread-nan",
    ]);
  });

  it("tie-breaks equal wait times by threadId instead of input order", () => {
    const threads = [makeThread("z-thread", 5), makeThread("a-thread", 5)];

    threads.sort(compareUnrespondedThreads);

    expect(threads.map((thread) => thread.threadId)).toEqual(["a-thread", "z-thread"]);
  });

  it("does not throw when threads tie, which is the common whole-day case", () => {
    const threads = [makeThread("b-thread", 3), makeThread("a-thread", 3)];

    expect(() => threads.sort(compareUnrespondedThreads)).not.toThrow();
  });
});

describe("sortGmailMessages", () => {
  it("orders unparsable receivedAt values last instead of returning NaN", () => {
    const sorted = sortGmailMessages([
      makeMessage({
        externalId: "msg-valid-older",
        receivedAt: "2026-05-01T10:00:00.000Z",
      }),
      makeMessage({
        externalId: "msg-invalid",
        receivedAt: "invalid-date-string",
      }),
      makeMessage({
        externalId: "msg-valid-newer",
        receivedAt: "2026-05-01T12:00:00.000Z",
      }),
    ]);

    expect(sorted.map((message) => message.externalId)).toEqual([
      "msg-valid-newer",
      "msg-valid-older",
      "msg-invalid",
    ]);
  });

  it("tie-breaks identical timestamps by externalId instead of input order", () => {
    const sorted = sortGmailMessages([
      makeMessage({
        externalId: "msg-z",
        receivedAt: "2026-05-01T10:00:00.000Z",
      }),
      makeMessage({
        externalId: "msg-a",
        receivedAt: "2026-05-01T10:00:00.000Z",
      }),
    ]);

    expect(sorted.map((message) => message.externalId)).toEqual(["msg-a", "msg-z"]);
  });
});
