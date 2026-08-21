/**
 * Regression tests proving `parseEmailAddresses` (backing `getMessage` /
 * `searchMessages` via `mapMessage`, and the `to`/`cc` lists on the rich
 * triage path via `mapRichMessage`) splits an RFC 5322 address list on
 * top-level commas only. A display name containing a comma — the corporate
 * "Last, First" form, e.g. `"Smith, Jane" <jane@corp.com>` — must not be cut
 * in half into a phantom `"Smith` recipient with no real address. Uses the
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
});
