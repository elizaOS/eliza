/**
 * Bulk Gmail manage through the installed googleapis HTTP client against a
 * loopback provider. Like Gmail, the provider rejects a batchModify or
 * batchDelete with more than 1000 ids, and it records how many trash
 * requests are in flight at once.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Auth } from "googleapis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

let server: Server;
let originalBase: string | undefined;
let client: GoogleGmailClient;
let batchSizes: number[] = [];
let trashInFlight = 0;
let trashMaxInFlight = 0;

beforeAll(async () => {
  originalBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://loopback.invalid");
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (
        url.pathname === "/gmail/v1/users/me/messages/batchModify" ||
        url.pathname === "/gmail/v1/users/me/messages/batchDelete"
      ) {
        const ids = (JSON.parse(body) as { ids: string[] }).ids;
        batchSizes.push(ids.length);
        if (ids.length > 1000) {
          response.writeHead(400);
          response.end(JSON.stringify({ error: { code: 400, message: "Too many ids" } }));
          return;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (/^\/gmail\/v1\/users\/me\/messages\/[^/]+\/trash$/.test(url.pathname)) {
        trashInFlight += 1;
        trashMaxInFlight = Math.max(trashMaxInFlight, trashInFlight);
        setTimeout(() => {
          trashInFlight -= 1;
          response.writeHead(200);
          response.end(JSON.stringify({ id: "trashed" }));
        }, 5);
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: 404 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${address.port}/`;
  client = new GoogleGmailClient(new GoogleApiClientFactory(new LoopbackCredentialResolver()));
});

beforeEach(() => {
  batchSizes = [];
  trashInFlight = 0;
  trashMaxInFlight = 0;
});

afterAll(async () => {
  if (originalBase === undefined) delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  else process.env.ELIZA_MOCK_GOOGLE_BASE = originalBase;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const ids = (count: number) => Array.from({ length: count }, (_, i) => `m${i + 1}`);

describe("Gmail bulk manage", () => {
  it("archives 2,400 messages in requests Gmail accepts", async () => {
    const receipt = await client.modifyGmailMessages({
      accountId: "owner-account",
      messageIds: ids(2400),
      operation: "archive",
    });

    expect(batchSizes).toEqual([1000, 1000, 400]);
    expect(receipt.succeededMessageIds).toHaveLength(2400);
    expect(receipt.failures).toEqual([]);
  });

  it("deletes 1,500 messages in requests Gmail accepts", async () => {
    const receipt = await client.modifyGmailMessages({
      accountId: "owner-account",
      messageIds: ids(1500),
      operation: "delete",
    });

    expect(batchSizes).toEqual([1000, 500]);
    expect(receipt.succeededMessageIds).toHaveLength(1500);
  });

  it("trashes many messages with bounded concurrency", async () => {
    const receipt = await client.modifyGmailMessages({
      accountId: "owner-account",
      messageIds: ids(100),
      operation: "trash",
    });

    expect(receipt.succeededMessageIds).toHaveLength(100);
    expect(trashMaxInFlight).toBeLessThanOrEqual(25);
  });
});
