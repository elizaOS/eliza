/**
 * Regression tests proving CR/LF sequences in caller-supplied header values
 * (subject, recipients, threading ids) cannot inject extra MIME headers into
 * the raw Gmail payload. Uses the real `GoogleGmailClient` with a stubbed
 * client factory that captures the base64url `raw` message; deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";

const account = { accountId: "acct-1" };

function createCapturingClient(): {
  client: GoogleGmailClient;
  sentRaw: () => string;
} {
  const send = vi.fn().mockResolvedValue({ data: { id: "m1", threadId: "t1", labelIds: [] } });
  const factory = {
    gmail: vi.fn().mockResolvedValue({ users: { messages: { send } } }),
  } as unknown as GoogleApiClientFactory;
  return {
    client: new GoogleGmailClient(factory),
    sentRaw: () => {
      const raw = send.mock.calls[0]?.[0]?.requestBody?.raw as string;
      return Buffer.from(raw, "base64url").toString("utf-8");
    },
  };
}

function headerBlock(mime: string): string {
  return mime.split("\r\n\r\n")[0] ?? "";
}

describe("gmail raw message header injection", () => {
  it("collapses CRLF in new-message subjects so no Bcc can be smuggled", async () => {
    const { client, sentRaw } = createCapturingClient();
    await client.sendGmailMessage({
      ...account,
      to: ["friend@example.com"],
      subject: "hi\r\nBcc: attacker@evil.com",
      bodyText: "hello",
    });
    const headers = headerBlock(sentRaw());
    expect(headers).toContain("Subject: hi Bcc: attacker@evil.com");
    expect(headers.split("\r\n")).not.toContain("Bcc: attacker@evil.com");
  });

  it("collapses CRLF in recipients and reply threading headers", async () => {
    const { client, sentRaw } = createCapturingClient();
    await client.sendGmailReply({
      ...account,
      to: ["friend@example.com\r\nBcc: attacker@evil.com"],
      subject: "Re: hello\r\nX-Injected: 1",
      bodyText: "reply",
      inReplyTo: "<id@x>\r\nX-Also-Injected: 1",
      references: "<id@x>",
    });
    const headerLines = headerBlock(sentRaw()).split("\r\n");
    expect(headerLines).not.toContain("Bcc: attacker@evil.com");
    expect(headerLines.some((line) => line.startsWith("X-Injected"))).toBe(false);
    expect(headerLines.some((line) => line.startsWith("X-Also-Injected"))).toBe(false);
  });
});
