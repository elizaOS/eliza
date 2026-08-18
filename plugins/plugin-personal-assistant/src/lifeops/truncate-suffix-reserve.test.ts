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

    for (const grapheme of ["🙂", "e\u0301", "👨‍👩‍👧‍👦"]) {
      const message = feed.messages[0];
      if (!message) throw new Error("expected triage fixture message");
      message.snippet = `${"g".repeat(98)}${grapheme}tail`;
      const bounded = formatEmailTriage(feed)
        .split("\n")
        .find((line) => line.startsWith("  g"))
        ?.slice(2);

      expect(bounded).toBe(`${"g".repeat(98)}…`);
      expect(bounded?.isWellFormed()).toBe(true);
      expect(bounded?.length).toBeLessThanOrEqual(100);
    }
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

  it("keeps astral, combining, and ZWJ graphemes intact", () => {
    const cases = ["🙂", "e\u0301", "👨‍👩‍👧‍👦"];

    for (const grapheme of cases) {
      const source = grapheme.repeat(100);
      const bodyCap = grapheme.length + `… [+${source.length} chars]`.length;
      const subject = redactSensitiveData(
        { subject: source },
        { subjectPreview: grapheme.length },
      ).subject;
      const body = redactSensitiveData(
        { body: source },
        { bodyPreview: bodyCap },
      ).body;

      expect(subject).toBe("…");
      expect(subject.isWellFormed()).toBe(true);
      expect(subject.length).toBeLessThanOrEqual(grapheme.length);
      expect(body.isWellFormed()).toBe(true);
      expect(body.length).toBeLessThanOrEqual(bodyCap);
      const match = body.match(/^(.*)… \[\+(\d+) chars\]$/su);
      expect(match).not.toBeNull();
      const prefix = match?.[1] ?? "";
      expect(prefix === "" || prefix === grapheme).toBe(true);
      expect(Number(match?.[2])).toBe(source.length - prefix.length);
    }
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

  it("stays truthful and maximal across omitted-count digit boundaries", () => {
    for (const sourceLength of [9, 10, 11, 99, 100, 101, 999, 1_000]) {
      const source = "b".repeat(sourceLength);
      for (let cap = 0; cap <= 60; cap += 1) {
        const body = redactSensitiveData(
          { body: source },
          { bodyPreview: cap },
        ).body;

        expect(body.length).toBeLessThanOrEqual(cap);
        if (sourceLength <= cap) {
          expect(body).toBe(source);
          continue;
        }
        if (cap === 0) {
          expect(body).toBe("");
          continue;
        }

        const match = body.match(/^(.*)… \[\+(\d+) chars\]$/s);
        if (!match) {
          expect(body).toBe("…");
          expect(`… [+${sourceLength} chars]`.length).toBeGreaterThan(cap);
          continue;
        }

        const prefix = match[1] ?? "";
        const omitted = Number(match[2]);
        expect(source.startsWith(prefix)).toBe(true);
        expect(omitted).toBe(sourceLength - prefix.length);

        const nextPrefixLength = prefix.length + 1;
        if (nextPrefixLength < sourceLength) {
          const candidate = `${source.slice(0, nextPrefixLength)}… [+${sourceLength - nextPrefixLength} chars]`;
          expect(candidate.length).toBeGreaterThan(cap);
        }
      }
    }
  });
});
