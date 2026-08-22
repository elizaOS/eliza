/**
 * Contract tests exercise the production Instagram Graph client over a real
 * loopback HTTP server. No client method or global fetch replacement is used.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstagramGraphClient } from "../graph-client.js";

interface WireRequest {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

describe("InstagramGraphClient loopback protocol", () => {
  const requests: WireRequest[] = [];
  let origin = "";
  let mode = "healthy";
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    requests.length = 0;
    mode = "healthy";
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      route(request, response, body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }

  function route(request: IncomingMessage, response: ServerResponse, body: string): void {
    const url = new URL(request.url ?? "/", origin);
    if (mode === "redirect") {
      response.writeHead(302, { location: "https://attacker.invalid/secret" });
      response.end();
      return;
    }
    if (mode === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"token":"${TOKEN}"`);
      return;
    }
    if (mode === "rate-limit") {
      json(response, 429, { error: { message: `provider leaked ${TOKEN}` } });
      return;
    }
    if (mode === "post-accept") {
      json(response, 503, { error: { message: `accepted but response failed ${TOKEN}` } });
      return;
    }
    if (mode === "oversized") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"data":"${"x".repeat(2 * 1024 * 1024)}"}`);
      return;
    }
    if (mode === "stall") return;
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      json(response, 401, { error: { message: "bad auth" } });
      return;
    }
    if (url.pathname === "/v24.0/account-1") {
      json(response, 200, { id: "account-1", username: "brand", name: "Brand" });
      return;
    }
    if (url.pathname === "/v24.0/user-1") {
      json(response, 200, {
        id: "user-1",
        username: "one",
        name: "One",
        followers_count: 7,
      });
      return;
    }
    if (url.pathname === "/v24.0/account-1/media") {
      json(response, 200, {
        data: [
          {
            id: "media-1",
            media_type: "IMAGE",
            media_url: "https://cdn.example.invalid/media-1.jpg",
            timestamp: "2026-08-21T12:03:00Z",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/v24.0/account-1/conversations") {
      if (url.searchParams.get("after") === "cursor-2") {
        json(response, 200, {
          data: [
            {
              id: "thread-2",
              updated_time: "2026-08-21T12:01:00Z",
              participants: { data: [{ id: "user-2", username: "two", name: "Two" }] },
            },
          ],
        });
      } else {
        json(response, 200, {
          data: [
            {
              id: "thread-1",
              updated_time: "2026-08-21T12:00:00Z",
              participants: {
                data: [
                  { id: "account-1", username: "brand", name: "Brand" },
                  { id: "user-1", username: "one", name: "One" },
                ],
              },
            },
          ],
          paging: {
            next: `${origin}/v24.0/account-1/conversations?after=cursor-2&access_token=leak`,
          },
        });
      }
      return;
    }
    if (url.pathname === "/v24.0/thread-1") {
      json(response, 200, {
        messages: {
          data: [
            {
              id: "message-1",
              created_time: "2026-08-21T12:02:00Z",
              from: { id: "user-1", username: "one", name: "One" },
              to: { data: [{ id: "account-1", username: "brand", name: "Brand" }] },
              message: "hello",
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/v24.0/thread-2") {
      json(response, 200, {
        messages: {
          data: [
            {
              id: "message-2",
              created_time: "2026-08-21T12:01:00Z",
              from: { id: "user-2", username: "two", name: "Two" },
              to: { data: [{ id: "account-1", username: "brand", name: "Brand" }] },
              message: "second",
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/v24.0/account-1/messages" && request.method === "POST") {
      expect(JSON.parse(body)).toEqual({
        recipient: { id: "user-1" },
        message: { text: "hello back" },
      });
      json(response, 200, { message_id: "outbound-1" });
      return;
    }
    if (url.pathname === "/v24.0/media-1/comments" && request.method === "POST") {
      expect(new URLSearchParams(body).get("message")).toBe("a comment");
      json(response, 200, { id: "comment-1" });
      return;
    }
    if (url.pathname === "/v24.0/comment-1/replies" && request.method === "POST") {
      expect(new URLSearchParams(body).get("message")).toBe("a reply");
      json(response, 200, { id: "reply-1" });
      return;
    }
    json(response, 404, { error: { message: "not found" } });
  }

  function client(timeout = 2_000, accessToken = TOKEN): InstagramGraphClient {
    return new InstagramGraphClient({
      accessToken,
      instagramAccountId: "account-1",
      graphBaseUrl: origin,
      graphApiVersion: "v24.0",
      requestTimeoutMs: timeout,
    });
  }

  it("authenticates, follows same-origin cursors, reads conversations, and sends through the real wire", async () => {
    const api = client();
    expect((await api.getOwnUser()).username).toBe("brand");
    const threads = await api.getThreads();
    expect(threads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
    expect((await api.getThreadMessages("thread-1"))[0]).toMatchObject({
      id: "message-1",
      text: "hello",
      user: { pk: "user-1" },
    });
    await expect(api.sendDirectMessage("thread-1", "hello back")).resolves.toBe("outbound-1");
    expect(requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(requests.some((request) => request.url.includes("access_token="))).toBe(false);
  });

  it("posts comments and replies through form-encoded Graph operations", async () => {
    const api = client();
    await expect(api.postComment("media-1", "a comment")).resolves.toBe("comment-1");
    await expect(api.replyToComment("comment-1", "a reply")).resolves.toBe("reply-1");
  });

  it("maps scoped profiles and professional-account media without numeric ID loss", async () => {
    const api = client();
    await expect(api.getUser("user-1")).resolves.toMatchObject({
      pk: "user-1",
      username: "one",
      followerCount: 7,
    });
    const discoveryError = await api.getUserByUsername("@one").catch((caught: unknown) => caught);
    expect((discoveryError as ElizaError).code).toBe("INSTAGRAM_CAPABILITY_UNSUPPORTED");
    await expect(api.getUserMedia("account-1")).resolves.toMatchObject([
      { pk: "media-1", mediaType: "photo" },
    ]);
  });

  it.each([
    ["malformed", "INSTAGRAM_GRAPH_INVALID_RESPONSE"],
    ["rate-limit", "INSTAGRAM_GRAPH_REJECTED"],
    ["redirect", "INSTAGRAM_GRAPH_REDIRECT"],
    ["oversized", "INSTAGRAM_GRAPH_INVALID_RESPONSE"],
  ])("fails closed for %s responses without leaking credentials", async (failureMode, code) => {
    mode = failureMode;
    const error = await client()
      .getOwnUser()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe(code);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("cancels stalled reads with a stable redacted error", async () => {
    mode = "stall";
    const error = await client(100)
      .getOwnUser()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("INSTAGRAM_GRAPH_CANCELLED");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("treats revoked credentials as a stable rejection and accepts a rotated client", async () => {
    const revoked = await client(2_000, "revoked-token")
      .getOwnUser()
      .catch((caught: unknown) => caught);
    expect((revoked as ElizaError).code).toBe("INSTAGRAM_GRAPH_REJECTED");
    expect((revoked as ElizaError).context).toMatchObject({ status: 401, retryable: false });
    await expect(client().getOwnUser()).resolves.toMatchObject({ pk: "account-1" });
  });

  it("classifies a post-accept server failure as an ambiguous write that must not auto-retry", async () => {
    mode = "post-accept";
    const error = await client()
      .postComment("media-1", "secret submitted content")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("INSTAGRAM_GRAPH_AMBIGUOUS_WRITE");
    expect(JSON.stringify(error)).not.toContain("secret submitted content");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(requests).toHaveLength(1);
  });

  it("rejects non-loopback HTTP and cross-origin paging targets", async () => {
    expect(
      () =>
        new InstagramGraphClient({
          accessToken: TOKEN,
          instagramAccountId: "account-1",
          graphBaseUrl: "http://example.com",
        })
    ).toThrowError(/requires HTTPS/);

    server.removeAllListeners("request");
    server.on("request", (_request, response) =>
      json(response, 200, {
        data: [],
        paging: { next: "https://attacker.invalid/v24.0/conversations?access_token=secret" },
      })
    );
    const error = await client()
      .getThreads()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("INSTAGRAM_GRAPH_REDIRECT");
  });
});

const TOKEN = "instagram-test-token-never-log";
