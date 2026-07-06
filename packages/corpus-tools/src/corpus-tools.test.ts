/**
 * Unit coverage for the #14748 corpus interchange: the checked-in synthetic
 * shard is validated from disk, mappers preserve the target mock contracts, and
 * invalid rows produce explicit diagnostics instead of fake-empty success.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertScrubStateTransition,
  CORPUS_ANCHOR_MS,
  toGmailFixtureMessage,
  toLifeOpsSimulatorChannelMessage,
  toLifeOpsSimulatorEmail,
  validateCorpusMessages,
  validateCorpusTarget,
} from "./index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "../fixtures/synthetic");

describe("@elizaos/corpus-tools", () => {
  it("validates the checked-in 20-row synthetic shard", async () => {
    const result = await validateCorpusTarget(fixtureDir);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.manifest.totals.messages).toBe(20);
    expect(result.manifest.shards).toHaveLength(1);
    expect(result.manifest.shards[0]).toMatchObject({
      path: "gmail/work/2026-06.jsonl",
      platform: "gmail",
      accountId: "work",
      month: "2026-06",
      count: 20,
    });
  });

  it("maps Gmail corpus rows to the Gmail mock fixture shape byte-stably", () => {
    const row = {
      id: "gmail-map-1",
      platform: "gmail",
      accountId: "work",
      threadId: "thread-map",
      ts: CORPUS_ANCHOR_MS - 60_000,
      direction: "in",
      senderId: "alice@example.test",
      senderDisplay: "Alice Example",
      recipients: [
        { id: "owner", display: "Owner", address: "owner@example.test" },
      ],
      subject: "Fixture mapping",
      text: "The body survives mapping.",
      labels: ["INBOX", "UNREAD"],
      attachments: [],
      scrubState: "verified",
    } as const;

    const parsed = validateCorpusMessages([row]);
    expect(parsed.ok).toBe(true);
    const fixture = toGmailFixtureMessage(parsed.messages[0]);

    expect(fixture).toEqual({
      id: "gmail-map-1",
      threadId: "thread-map",
      accountId: "work",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "The body survives mapping.",
      internalDateOffsetMs: -60_000,
      headers: [
        { name: "From", value: "Alice Example <alice@example.test>" },
        { name: "To", value: "Owner <owner@example.test>" },
        { name: "Subject", value: "Fixture mapping" },
        { name: "Message-Id", value: "<gmail-map-1@corpus-tools.local>" },
      ],
      bodyText: "The body survives mapping.",
    });
  });

  it("maps incoming Gmail rows to LifeOps simulator email fixtures", () => {
    const parsed = validateCorpusMessages([
      {
        id: "lifeops-email-1",
        platform: "gmail",
        accountId: "home",
        threadId: "thread-lifeops",
        ts: CORPUS_ANCHOR_MS - 120_000,
        direction: "in",
        senderId: "priya@example.test",
        senderDisplay: "Priya Example",
        recipients: [
          { id: "owner", display: "Owner", address: "owner@example.test" },
        ],
        subject: "Calendar invite",
        text: "Please add the attendee list.",
        labels: ["INBOX"],
        attachments: [],
        scrubState: "verified",
      },
    ]);

    expect(parsed.ok).toBe(true);
    expect(
      toLifeOpsSimulatorEmail(parsed.messages[0], {
        personKeyForSender: () => "priya",
      }),
    ).toEqual({
      id: "lifeops-email-1",
      threadId: "thread-lifeops",
      fromPersonKey: "priya",
      subject: "Calendar invite",
      snippet: "Please add the attendee list.",
      bodyText: "Please add the attendee list.",
      labels: ["INBOX"],
      internalDateOffsetMs: -120_000,
      accountId: "home",
    });
  });

  it("maps X rows through the documented telegram-shaped simulator fallback", () => {
    const parsed = validateCorpusMessages([
      {
        id: "x-map-1",
        platform: "x",
        accountId: "owner-x",
        threadId: "dm-42",
        ts: CORPUS_ANCHOR_MS - 180_000,
        direction: "in",
        senderId: "old-friend",
        senderDisplay: "Old Friend",
        recipients: [{ id: "owner" }],
        subject: "Old Friend",
        text: "Want to reconnect next week?",
        labels: [],
        attachments: [],
        scrubState: "verified",
      },
    ]);

    expect(parsed.ok).toBe(true);
    expect(toLifeOpsSimulatorChannelMessage(parsed.messages[0])).toEqual({
      id: "x-map-1",
      channel: "telegram",
      threadId: "dm-42",
      threadName: "X: Old Friend",
      threadType: "dm",
      fromPersonKey: "old-friend",
      text: "Want to reconnect next week?",
      sentAtOffsetMs: -180_000,
      unread: true,
      outgoing: undefined,
    });
  });

  it("reports duplicate ids and missing reply references explicitly", () => {
    const row = {
      id: "dup",
      platform: "gmail",
      accountId: "work",
      threadId: "thread",
      ts: CORPUS_ANCHOR_MS - 1,
      direction: "in",
      senderId: "sender@example.test",
      senderDisplay: "Sender",
      recipients: [{ id: "owner" }],
      text: "hello",
      labels: [],
      attachments: [],
      scrubState: "verified",
    };

    const result = validateCorpusMessages([
      row,
      { ...row, replyToId: "missing" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "duplicate-id",
      "reply-missing",
    ]);
  });

  it("rejects scrub-state regression", () => {
    expect(() => assertScrubStateTransition("swapped", "raw")).toThrow(
      "scrubState regressed",
    );
    expect(() =>
      assertScrubStateTransition("swapped", "verified"),
    ).not.toThrow();
  });
});
