/**
 * Exercises bounded preview output through the exported Gmail formatter and
 * audit redactor, including truthful omission diagnostics at small caps.
 */
import type { LifeOpsGmailTriageFeed } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { formatEmailTriage } from "./google/format-helpers.ts";
import { redactSensitiveData } from "./redact-sensitive-data.ts";

describe("preview suffix reservation", () => {
  it("bounds the real Gmail triage snippet including its ellipsis", () => {
    const now = "2026-08-18T12:00:00.000Z";
    const feed: LifeOpsGmailTriageFeed = {
      source: "cache",
      syncedAt: now,
      summary: {
        unreadCount: 1,
        importantNewCount: 0,
        likelyReplyNeededCount: 0,
      },
      messages: [
        {
          id: "mail-1",
          externalId: "external-1",
          agentId: "agent-1",
          provider: "google",
          side: "personal",
          threadId: "thread-1",
          subject: "Subject",
          from: "Sender",
          fromEmail: "sender@example.com",
          replyTo: null,
          to: [],
          cc: [],
          snippet: "g".repeat(140),
          receivedAt: now,
          isUnread: true,
          isImportant: false,
          likelyReplyNeeded: false,
          triageScore: 0,
          triageReason: "",
          labels: [],
          htmlLink: null,
          metadata: {},
          syncedAt: now,
          updatedAt: now,
        },
      ],
    };

    const snippetLine = formatEmailTriage(feed)
      .split("\n")
      .find((line) => line.startsWith("  g"));
    const snippet = snippetLine?.slice(2);

    expect(snippet).toBe(`${"g".repeat(99)}…`);
    expect(snippet).toHaveLength(100);
  });

  it("bounds subject previews at zero, one, fractional, and normal caps", () => {
    const subject = "s".repeat(100);

    expect(
      redactSensitiveData({ subject }, { subjectPreview: 0 }).subject,
    ).toBe("");
    expect(
      redactSensitiveData({ subject }, { subjectPreview: 1 }).subject,
    ).toBe("…");
    expect(
      redactSensitiveData({ subject }, { subjectPreview: 5.9 }).subject,
    ).toBe("ssss…");
    expect(
      redactSensitiveData({ subject }, { subjectPreview: 20 }).subject,
    ).toBe(`${"s".repeat(19)}…`);
  });

  it("reports the actual omitted body characters within the cap", () => {
    const source = "b".repeat(100);
    const body = redactSensitiveData(
      { body: source },
      { bodyPreview: 30 },
    ).body;
    const match = body.match(/^(.*)… \[\+(\d+) chars\]$/s);

    expect(body.length).toBeLessThanOrEqual(30);
    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBe(source.length - (match?.[1].length ?? 0));
  });

  it("uses an honest marker when a complete omission diagnostic cannot fit", () => {
    const source = "b".repeat(100);

    expect(redactSensitiveData({ body: source }, { bodyPreview: 0 }).body).toBe(
      "",
    );
    expect(redactSensitiveData({ body: source }, { bodyPreview: 1 }).body).toBe(
      "…",
    );
    expect(
      redactSensitiveData({ body: source }, { bodyPreview: 10 }).body,
    ).toBe("…");
  });
});
