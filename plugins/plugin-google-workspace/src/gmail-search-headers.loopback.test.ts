/**
 * Gmail operations through the installed googleapis HTTP client against a
 * loopback provider. Search returns only the requested metadata headers, and
 * send can return a malformed receipt with no provider message id.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Auth } from "googleapis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";
import type { GoogleAuthClient, GoogleCredentialResolver } from "./types.js";

class LoopbackCredentialResolver implements GoogleCredentialResolver {
  async getAuthClient(): Promise<GoogleAuthClient> {
    const auth = new Auth.OAuth2Client();
    auth.setCredentials({
      access_token: "loopback-google-token",
      expiry_date: Date.now() + 60 * 60 * 1000,
    });
    return auth;
  }
}

const NEWSLETTER_HEADERS = [
  { name: "Subject", value: "Weekly deals" },
  { name: "From", value: "Deals <news@shop.example>" },
  { name: "To", value: "owner@example.com" },
  { name: "Cc", value: "partner@example.com" },
  { name: "Reply-To", value: "support@shop.example" },
  { name: "Date", value: "Mon, 20 Apr 2026 10:00:00 +0000" },
  {
    name: "List-Unsubscribe",
    value: "<https://shop.example/unsub?u=1>, <mailto:unsub@shop.example>",
  },
  { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
];

let server: Server;
let originalBase: string | undefined;
let client: GoogleGmailClient;

beforeAll(async () => {
  originalBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://loopback.invalid");
    response.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/gmail/v1/users/me/messages") {
      response.end(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages/m1") {
      const requested = new Set(
        url.searchParams.getAll("metadataHeaders").map((name) => name.toLowerCase())
      );
      response.end(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
          payload: {
            headers: NEWSLETTER_HEADERS.filter((header) =>
              requested.has(header.name.toLowerCase())
            ),
          },
        })
      );
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages/send") {
      response.end(JSON.stringify({ threadId: "sent-thread-without-message" }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: { code: 404 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${address.port}/`;
  client = new GoogleGmailClient(new GoogleApiClientFactory(new LoopbackCredentialResolver()));
});

afterAll(async () => {
  if (originalBase === undefined) delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  else process.env.ELIZA_MOCK_GOOGLE_BASE = originalBase;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("Gmail HTTP client", () => {
  it("returns the unsubscribe, Cc and Reply-To headers of a searched message", async () => {
    const [message] = await client.searchMessages({
      accountId: "owner-account",
      query: "list:*",
    });

    expect(message?.headers).toMatchObject({
      "List-Unsubscribe": "<https://shop.example/unsub?u=1>, <mailto:unsub@shop.example>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(message?.cc).toEqual([{ email: "partner@example.com" }]);
    expect(message?.replyTo).toEqual({ email: "support@shop.example" });
  });

  it("rejects a send response that has no provider message id", async () => {
    await expect(
      client.sendGmailMessage({
        accountId: "owner-account",
        to: ["recipient@example.com"],
        subject: "Receipt check",
        bodyText: "Hello",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_GMAIL_SEND_RECEIPT_MISSING" });
  });
});
