/**
 * Regression tests proving `parseEmailAddresses`/`parseMailbox` (backing
 * `getMessage`/`searchMessages` via `mapMessage`, and the rich triage path via
 * `mapRichMessage`/`getGmailMessageDetail`) scan RFC 5322 address lists with a
 * real state machine and split only on top-level commas. Commas protected by a
 * quoted string, an escaped quote (`\"`), an RFC comment (`(Team, West)`), or
 * an angle-addr route must not manufacture a phantom recipient, malformed
 * unterminated contexts must fail closed rather than inflate the recipient
 * count, and only a plausible addr-spec may be presented as an email. Uses the
 * real `GoogleGmailClient` with a stubbed client factory that returns a fixed
 * `messages.get` payload; deterministic, no network.
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

describe("parseEmailAddresses top-level comma splitting", () => {
  it("keeps a quoted-comma 'Last, First' sender identity intact", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: '"Smith, Jane" <jane@corp.com>' },
        { name: "To", value: "me@corp.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.from?.email).toBe("jane@corp.com");
    expect(msg.from?.name).toBe("Smith, Jane");
  });

  it("does not inject a phantom recipient when a To name contains a comma", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: '"Smith, Jane" <jane@corp.com>, bob@x.com' },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to).toHaveLength(2);
    expect(msg.to?.map((address) => address.email)).toEqual(["jane@corp.com", "bob@x.com"]);
    expect(msg.to?.[0]?.name).toBe("Smith, Jane");
  });

  it("still parses a plain multi-address list into distinct addresses", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "a@x.com, b@y.com" },
        { name: "Cc", value: "c@z.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to?.map((address) => address.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(msg.cc).toHaveLength(1);
    expect(msg.cc?.[0]?.email).toBe("c@z.com");
  });

  it("parses a bare single address with no display name or angle brackets", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "carol@z.com" },
        { name: "To", value: "me@corp.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.from).toEqual({ email: "carol@z.com" });
  });

  it("resolves a Reply-To whose display name carries a comma", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "me@corp.com" },
        { name: "Reply-To", value: '"Doe, John" <john@corp.com>' },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.replyTo?.email).toBe("john@corp.com");
    expect(msg.replyTo?.name).toBe("Doe, John");
  });

  it("keeps an escaped-quote-then-comma display name as one recipient", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        // Display name with an escaped quote *before* the comma: a scanner that
        // toggles quote state on the escaped quote would treat the following
        // comma as a separator and split the mailbox.
        { name: "To", value: '"\\"Q\\", Bob" <bob@x.com>, carol@y.com' },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to?.map((address) => address.email)).toEqual(["bob@x.com", "carol@y.com"]);
    expect(msg.to?.[0]?.name).toBe('"Q", Bob');
  });

  it("does not split inside a comma-bearing RFC comment", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "ops@corp.com (Team, West), dana@y.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to?.map((address) => address.email)).toEqual(["ops@corp.com", "dana@y.com"]);
  });

  it("handles escaped parentheses inside a comment without leaking a recipient", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "erin@corp.com (weird \\) comment, still one), fred@y.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to?.map((address) => address.email)).toEqual(["erin@corp.com", "fred@y.com"]);
  });

  it("does not split or strip syntax inside a domain literal", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        {
          name: "To",
          value: "literal@[zone,(west),still-one], second@example.com",
        },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to?.map((address) => address.email)).toEqual([
      "literal@[zone,(west),still-one]",
      "second@example.com",
    ]);
  });

  it("keeps an escaped closing bracket and comma inside a domain literal", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        {
          name: "To",
          value: "literal@[zone\\],west], second@example.com",
        },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to?.map((address) => address.email)).toEqual([
      "literal@[zone\\],west]",
      "second@example.com",
    ]);
  });

  it("parses a mixed quoted/comment/plain multi-address list without phantoms", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        {
          name: "To",
          value: '"Smith, Jane" <jane@corp.com>, plain@x.com, ops@corp.com (Team, West)',
        },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to).toHaveLength(3);
    expect(msg.to?.map((address) => address.email)).toEqual([
      "jane@corp.com",
      "plain@x.com",
      "ops@corp.com",
    ]);
    expect(msg.to?.[0]?.name).toBe("Smith, Jane");
  });

  it("never manufactures multiple recipients from an unterminated quote", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        // Unterminated quote: the comma boundaries are untrustworthy, so the
        // scanner collapses to one opaque token rather than several mailboxes.
        { name: "To", value: '"Broken, Name <bad@x.com>, real@y.com' },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    const emails = msg.to?.map((address) => address.email) ?? [];
    expect(emails.length).toBeLessThanOrEqual(1);
    expect(emails).not.toContain("real@y.com");
  });

  it("never manufactures multiple recipients from an unterminated comment", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "gia@x.com (open, comment, hank@y.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    const emails = msg.to?.map((address) => address.email) ?? [];
    expect(emails.length).toBeLessThanOrEqual(1);
    expect(emails).not.toContain("hank@y.com");
  });

  it("never manufactures multiple recipients from an unterminated angle address", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "Ivy <ivy@x.com, jack@y.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    const emails = msg.to?.map((address) => address.email) ?? [];
    expect(emails.length).toBeLessThanOrEqual(1);
    expect(emails).not.toContain("jack@y.com");
  });

  it("drops a bare display-name fragment with no plausible email", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "sender@corp.com" },
        { name: "To", value: "Marketing Team, real@y.com" },
      ])
    );
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.to?.map((address) => address.email)).toEqual(["real@y.com"]);
  });
});

describe("rich triage path (mapRichMessage) top-level comma splitting", () => {
  it("keeps quoted-comma names and comment recipients intact on the rich path", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: '"Smith, Jane" <jane@corp.com>' },
        { name: "To", value: '"Doe, John" <john@corp.com>, ops@corp.com (Team, West)' },
        { name: "Cc", value: "cc1@z.com, cc2@z.com" },
      ])
    );
    const detail = await client.getGmailMessageDetail({ accountId: "a1", messageId: "m1" });
    expect(detail).not.toBeNull();
    expect(detail?.message.from).toBe("Smith, Jane");
    expect(detail?.message.fromEmail).toBe("jane@corp.com");
    expect(detail?.message.to).toEqual(["john@corp.com", "ops@corp.com"]);
    expect(detail?.message.cc).toEqual(["cc1@z.com", "cc2@z.com"]);
  });

  it("falls back to 'Unknown sender' when From carries no plausible address", async () => {
    const client = clientReturning(
      messageWithHeaders([
        { name: "From", value: "Marketing Team" },
        { name: "To", value: "me@corp.com" },
      ])
    );
    const detail = await client.getGmailMessageDetail({ accountId: "a1", messageId: "m1" });
    expect(detail?.message.from).toBe("Unknown sender");
    expect(detail?.message.fromEmail).toBeNull();
  });
});
