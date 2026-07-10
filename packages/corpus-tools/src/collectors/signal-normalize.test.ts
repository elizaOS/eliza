/**
 * Signal row → CorpusMessage normalization tests. Drives the real normalizer
 * over Signal-shaped rows (json column authoritative, columns as fallback) and
 * asserts direction, sender/thread identity, timestamp precedence, and every
 * skip branch. Every produced message is validated against the corpus schema so
 * a mapping regression fails here, not at publish time.
 */
import { describe, expect, it } from "vitest";
import { CORPUS_CUTOFF_MS, corpusMessageSchema } from "../schema.ts";
import type { SignalMessageRow } from "./signal-db.ts";
import { normalizeSignalRow } from "./signal-normalize.ts";

const OPTIONS = {
  accountId: "primary",
  ownerId: "owner-uuid",
  ownerDisplay: "Owner",
};

const AFTER_CUTOFF = CORPUS_CUTOFF_MS + 86_400_000;

function row(overrides: Partial<SignalMessageRow>): SignalMessageRow {
  return {
    id: "m1",
    json: null,
    sent_at: null,
    received_at: AFTER_CUTOFF,
    conversationId: "conv-1",
    type: "incoming",
    body: "hello",
    source: "peer-uuid",
    sourceServiceId: null,
    conversationName: "Alice",
    conversationType: "private",
    conversationE164: "+15551230000",
    conversationServiceId: "peer-service-id",
    ...overrides,
  };
}

describe("normalizeSignalRow", () => {
  it("maps an incoming message to a validated CorpusMessage", () => {
    const result = normalizeSignalRow(row({}), OPTIONS);
    expect(result.skipped).toBeUndefined();
    const message = result.message;
    expect(message).toBeDefined();
    if (!message) throw new Error("unreachable");
    expect(corpusMessageSchema.parse(message)).toBeTruthy();
    expect(message.direction).toBe("in");
    expect(message.senderId).toBe("peer-uuid");
    expect(message.senderDisplay).toBe("Alice");
    expect(message.threadId).toBe("signal:primary:conv-1");
    expect(message.id).toBe("signal:primary:m1");
    expect(message.recipients[0].id).toBe("owner-uuid");
    expect(message.ts).toBe(AFTER_CUTOFF);
  });

  it("maps an outgoing message from the owner", () => {
    const result = normalizeSignalRow(
      row({ id: "m2", type: "outgoing", body: "sent" }),
      OPTIONS,
    );
    const message = result.message;
    if (!message) throw new Error("expected a message");
    expect(message.direction).toBe("out");
    expect(message.senderId).toBe("owner-uuid");
    expect(message.senderDisplay).toBe("Owner");
    expect(message.recipients[0].id).toBe("peer-uuid");
    expect(message.recipients[0].display).toBe("Alice");
  });

  it("reads body and timestamp from the json column when columns are null", () => {
    const result = normalizeSignalRow(
      row({
        body: null,
        received_at: null,
        type: null,
        json: JSON.stringify({
          body: "from json",
          received_at: AFTER_CUTOFF + 5,
          type: "incoming",
        }),
      }),
      OPTIONS,
    );
    const message = result.message;
    if (!message) throw new Error("expected a message");
    expect(message.text).toBe("from json");
    expect(message.ts).toBe(AFTER_CUTOFF + 5);
  });

  it("prefers received_at over sent_at for ordering", () => {
    const result = normalizeSignalRow(
      row({ received_at: AFTER_CUTOFF + 100, sent_at: AFTER_CUTOFF }),
      OPTIONS,
    );
    expect(result.message?.ts).toBe(AFTER_CUTOFF + 100);
  });

  it("skips a message with no readable body", () => {
    const result = normalizeSignalRow(
      row({ body: null, json: JSON.stringify({ type: "incoming" }) }),
      OPTIONS,
    );
    expect(result.skipped).toBe("empty-body");
    expect(result.message).toBeUndefined();
  });

  it("skips a message with an unknown direction type", () => {
    const result = normalizeSignalRow(
      row({ type: "group-update", json: JSON.stringify({}) }),
      OPTIONS,
    );
    expect(result.skipped).toBe("empty-body");
  });

  it("skips a message before the corpus cutoff", () => {
    const result = normalizeSignalRow(
      row({ received_at: CORPUS_CUTOFF_MS - 1 }),
      OPTIONS,
    );
    expect(result.skipped).toBe("before-cutoff");
  });

  it("skips a message with no resolvable timestamp", () => {
    const result = normalizeSignalRow(
      row({
        received_at: null,
        sent_at: null,
        json: JSON.stringify({ body: "x", type: "incoming" }),
      }),
      OPTIONS,
    );
    expect(result.skipped).toBe("no-timestamp");
  });
});
