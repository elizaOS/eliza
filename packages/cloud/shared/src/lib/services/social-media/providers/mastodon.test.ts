import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mastodonProvider } from "./mastodon";

const originalFetch = globalThis.fetch;
let statusPosts: Array<{ idempotencyKey: string | null; body: unknown }>;
let failFirstStatusPost: boolean;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Stands in for a Mastodon instance whose proxy answers 502 after the status
// was already created, so the client retries the same POST.
function stubMastodonInstance(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input.toString());
  if (url.pathname === "/api/v1/statuses" && init?.method === "POST") {
    statusPosts.push({
      idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
      body: JSON.parse(String(init.body)),
    });
    if (failFirstStatusPost && statusPosts.length === 1) {
      return Promise.resolve(new Response("Bad Gateway", { status: 502 }));
    }
    return Promise.resolve(
      json({
        id: "110000000000000001",
        url: "https://mastodon.example/@app/110000000000000001",
        visibility: "public",
      }),
    );
  }
  return Promise.resolve(json({ error: "not found" }, 404));
}

describe("mastodonProvider.createPost", () => {
  beforeEach(() => {
    statusPosts = [];
    failFirstStatusPost = false;
    globalThis.fetch = stubMastodonInstance as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const credentials = { accessToken: "token", instanceUrl: "https://mastodon.example" };

  test("a retried status POST carries the same Idempotency-Key", async () => {
    failFirstStatusPost = true;
    const result = await mastodonProvider.createPost(credentials, { text: "Try our app" });

    expect(result.success).toBe(true);
    expect(statusPosts).toHaveLength(2);
    const [first, second] = statusPosts;
    expect(first.idempotencyKey).toBeTruthy();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  test("each new post gets its own Idempotency-Key", async () => {
    await mastodonProvider.createPost(credentials, { text: "First" });
    await mastodonProvider.createPost(credentials, { text: "Second" });

    expect(statusPosts).toHaveLength(2);
    expect(statusPosts[0].idempotencyKey).toBeTruthy();
    expect(statusPosts[1].idempotencyKey).toBeTruthy();
    expect(statusPosts[1].idempotencyKey).not.toBe(statusPosts[0].idempotencyKey);
  });
});
