/**
 * Regression tests proving RFC 5322 §2.2.3 folded address headers (CRLF + WSP
 * continuations) parse identically to their unfolded spelling on both the
 * `getMessage`/`searchMessages` path via `mapMessage` and the rich triage path
 * via `mapRichMessage`/`getGmailMessageDetail`. Before unfolding, a fold
 * between the display name and the angle-addr defeated `parseMailbox`'s
 * single-line regex and the whole mailbox was silently dropped (`Unknown
 * sender` on the rich path); a fold inside a quoted string or quoted local
 * part embedded the literal line break into the parsed value. Uses the real
 * `GoogleGmailClient` with a stubbed client factory returning fixed
 * `messages.get` payloads; deterministic, no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";

function clientReturning(data: Record<string, unknown>): GoogleGmailClient {
  const get = vi.fn().mockResolvedValue({ data });
  const factory = {
    gmail: vi.fn().mockResolvedValue({ users: { messages: { get } } }),
  } as unknown as GoogleApiClientFactory;
  return new GoogleGmailClient(factory);
}

function messageWithHeaders(
  headers: Array<{ name: string; value: string }>
): Record<string, unknown> {
  return {
    id: "m1",
    threadId: "t1",
    snippet: "hi",
    labelIds: ["INBOX"],
    internalDate: "0",
    payload: { headers },
  };
}

describe("mapMessage folded (RFC 5322 2.2.3) address headers", () => {
  it("parses a folded From display name identically to the unfolded spelling", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "Jane Smith\r\n <jane@corp.com>" },
        { name: "To", value: "me@corp.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.from).toEqual({ email: "jane@corp.com", name: "Jane Smith" });
  });

  it("parses a folded To list with display names into distinct addresses", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        {
          name: "To",
          value: "Jane Smith\r\n <jane@corp.com>, Bob\r\n Doe <bob@x.com>",
        },
        { name: "Cc", value: "Carol\r\n <carol@y.com>" },
        { name: "Reply-To", value: "Reply Desk\r\n <replies@corp.com>" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to).toEqual([
      { email: "jane@corp.com", name: "Jane Smith" },
      { email: "bob@x.com", name: "Bob Doe" },
    ]);
    expect(msg.cc).toEqual([{ email: "carol@y.com", name: "Carol" }]);
    expect(msg.replyTo).toEqual({ email: "replies@corp.com", name: "Reply Desk" });
  });

  it("keeps a folded quoted display name without embedding the line break", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: '"Doe,\r\n Jane" <jane@corp.com>' },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to).toEqual([{ email: "jane@corp.com", name: "Doe, Jane" }]);
  });

  it("preserves a folded quoted local part", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: '"weird\r\n name"@example.com' },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to).toEqual([{ email: '"weird name"@example.com' }]);
  });

  it("unfolds LF-only continuations the same way as CRLF folds", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "Jane Smith\n <jane@corp.com>" },
        { name: "To", value: "me@corp.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.from).toEqual({ email: "jane@corp.com", name: "Jane Smith" });
  });

  it("still fails closed on a fold inside an addr-spec domain", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "<jane@\r\n corp.com>" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to).toEqual([]);
  });

  it("treats a line break without a WSP continuation as malformed, not a fold", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "a@x.com\r\nb@y.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to).toEqual([]);
  });

  it("drops a mailbox whose angle-addr is split by a bare line break", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "Jane\r\n<jane@corp.com>" },
        { name: "To", value: "me@corp.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.from).toBeUndefined();
  });

  it("unfolds tab continuations and consecutive obs-folds", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "Jane\r\n\t Smith\r\n <jane@corp.com>" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    // Unfolding removes only the CRLF; the retained WSP (tab, space) stays in
    // the display name, matching the unfolded spelling with the same runs.
    expect(msg.to).toEqual([{ email: "jane@corp.com", name: "Jane\t Smith" }]);
  });
});

describe("mapRichMessage folded address headers", () => {
  it("resolves a folded rich-path From to the real sender, not 'Unknown sender'", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "Jane Smith\r\n <jane@corp.com>" },
        { name: "To", value: "me@corp.com" },
      ])
    );
    const detail = await client.getGmailMessageDetail({ accountId: "a1", messageId: "m1" });
    expect(detail?.message.from).toBe("Jane Smith");
    expect(detail?.message.fromEmail).toBe("jane@corp.com");
  });

  it("keeps folded To display names on the rich path", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "Jane Smith\r\n <jane@corp.com>, bob@x.com" },
      ])
    );
    const detail = await client.getGmailMessageDetail({ accountId: "a1", messageId: "m1" });
    expect(detail?.message.to).toEqual(["jane@corp.com", "bob@x.com"]);
  });
});
