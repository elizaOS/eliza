/**
 * A reply to a message whose Reply-To lists several addresses goes to all of
 * them (RFC 5322 §3.6.2: Reply-To is an address-list). Real
 * GoogleWorkspaceService, googleapis client and GoogleGmailAdapter against a
 * loopback Gmail provider.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { Auth } from "googleapis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.js";
import { GoogleWorkspaceService } from "./service.js";

const HEADERS = [
  { name: "From", value: "Ticket bot <noreply@vendor.example>" },
  {
    name: "Reply-To",
    value: "Alice <alice@vendor.example>, Bob <bob@vendor.example>",
  },
  { name: "To", value: "me@example.com" },
  { name: "Subject", value: "Contract renewal" },
  { name: "Message-Id", value: "<m1@vendor.example>" },
];

const sent: string[] = [];
let server: Server;
let runtime: IAgentRuntime;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://loopback.invalid");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === "/gmail/v1/users/me/messages") {
      response.end(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/gmail/v1/users/me/messages/m1") {
      response.end(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX"],
          internalDate: String(Date.parse("2026-10-15T09:00:00Z")),
          historyId: "1",
          snippet: "",
          payload: { headers: HEADERS },
        })
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/gmail/v1/users/me/messages/send") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const raw = (JSON.parse(body) as { raw: string }).raw;
        sent.push(Buffer.from(raw, "base64url").toString("utf8"));
        response.end(JSON.stringify({ id: "sent-1", threadId: "t1", labelIds: ["SENT"] }));
      });
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const credentialResolver = {
    async getAuthClient() {
      const auth = new Auth.OAuth2Client();
      auth.setCredentials({
        access_token: "loopback-google-token",
        expiry_date: Date.now() + 60 * 60 * 1000,
      });
      return auth;
    },
  };
  const service = new GoogleWorkspaceService(undefined, {
    credentialResolver,
    apiRootUrl: root,
  });
  runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: (name: string) => (name === "google" ? service : null),
    emitEvent: async () => undefined,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

it("replies to every address in the Reply-To list", async () => {
  const adapter = new GoogleGmailAdapter();
  const [found] = await adapter.searchMessages(runtime, { content: "Contract" });
  if (!found) throw new Error("search returned no message");
  const draft = await adapter.createDraft(runtime, {
    source: "gmail",
    to: [],
    body: "Approved.",
    inReplyToId: found.id,
  });
  await adapter.sendDraft(runtime, draft.draftId);

  const toLine = sent[0]?.split("\r\n").find((line) => line.startsWith("To:"));
  expect(toLine).toBe("To: alice@vendor.example, bob@vendor.example");
});
