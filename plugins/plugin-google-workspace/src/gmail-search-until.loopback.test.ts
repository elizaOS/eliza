/**
 * A Gmail search bounded by `untilMs` honors its result limit: it reads only
 * the messages it needs, still drops messages later in the bound's final
 * second (Gmail's `before:` has whole-second precision), and returns the
 * newest messages at or before the bound. Real GoogleWorkspaceService,
 * googleapis client and GoogleGmailAdapter against a loopback Gmail provider.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { Auth } from "googleapis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.js";
import { GoogleWorkspaceService } from "./service.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const UNTIL = BASE + 499 * 3_600_000 + 400;
// 500 hourly messages, then two more in the bound's final second, after it.
const MAILBOX = [
  ...Array.from({ length: 500 }, (_, index) => ({
    id: `m${index}`,
    internalDate: BASE + index * 3_600_000,
  })),
  { id: "late-1", internalDate: UNTIL + 200 },
  { id: "late-2", internalDate: UNTIL + 500 },
];

let server: Server;
let runtime: IAgentRuntime;
let messageReads = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://loopback.invalid");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === "/gmail/v1/users/me/messages") {
      const before = /before:(\d+)/.exec(url.searchParams.get("q") ?? "");
      const matches = MAILBOX.filter(
        (message) => !before || message.internalDate < Number(before[1]) * 1000
      ).sort((left, right) => right.internalDate - left.internalDate);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Number(url.searchParams.get("maxResults") ?? 100);
      const page = matches.slice(start, start + size);
      const next = start + size < matches.length ? String(start + size) : undefined;
      response.end(
        JSON.stringify({
          messages: page.map((message) => ({ id: message.id, threadId: message.id })),
          ...(next ? { nextPageToken: next } : {}),
        })
      );
      return;
    }
    const get = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    const message = get ? MAILBOX.find((entry) => entry.id === get[1]) : undefined;
    if (request.method === "GET" && message) {
      messageReads += 1;
      response.end(
        JSON.stringify({
          id: message.id,
          threadId: message.id,
          labelIds: ["INBOX"],
          internalDate: String(message.internalDate),
          historyId: "1",
          snippet: "",
          payload: {
            headers: [
              { name: "From", value: "sender@example.com" },
              { name: "Subject", value: message.id },
            ],
          },
        })
      );
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

it("returns the newest messages up to the bound without reading the whole mailbox", async () => {
  const hits = await new GoogleGmailAdapter().searchMessages(runtime, {
    untilMs: UNTIL,
    limit: 5,
  });

  expect(hits.map((hit) => hit.subject)).toEqual(["m499", "m498", "m497", "m496", "m495"]);
  // The limit plus the two messages from the bound's final second, read twice
  // at most; never the 502 matches.
  expect(messageReads).toBeLessThanOrEqual(20);
});
