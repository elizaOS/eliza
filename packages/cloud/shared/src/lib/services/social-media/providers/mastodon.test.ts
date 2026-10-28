import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mastodonProvider } from "./mastodon";

const originalFetch = globalThis.fetch;
// withRetry backs off 1s, 2s, 4s between the four attempts of an exhausted request.
const EXHAUSTED_RETRY_TIMEOUT_MS = 15_000;
let statusPosts: Array<{ idempotencyKey: string | null; body: unknown }>;
let failFirstStatusPost: boolean;
let statusPostResponse: (() => Response) | null;
let deleteResponse: (() => Response) | null;

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
    if (statusPostResponse) return Promise.resolve(statusPostResponse());
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
  if (url.pathname.startsWith("/api/v1/statuses/") && init?.method === "DELETE" && deleteResponse) {
    return Promise.resolve(deleteResponse());
  }
  return Promise.resolve(json({ error: "not found" }, 404));
}

describe("mastodonProvider.createPost", () => {
  beforeEach(() => {
    statusPosts = [];
    failFirstStatusPost = false;
    statusPostResponse = null;
    deleteResponse = null;
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

  test(
    "a replayed status POST that never gets an answer holds the credit",
    async () => {
      statusPostResponse = () => new Response("Bad Gateway", { status: 502 });
      const result = await mastodonProvider.createPost(credentials, { text: "Maybe posted" });

      expect(statusPosts).toHaveLength(4);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
      expect(result.creditDisposition).toBe("hold");
    },
    EXHAUSTED_RETRY_TIMEOUT_MS,
  );

  test(
    "a replayed status POST rate limited after an unanswered attempt holds the credit",
    async () => {
      statusPostResponse = () =>
        statusPosts.length === 1
          ? new Response("Bad Gateway", { status: 502 })
          : new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "0" } });
      const result = await mastodonProvider.createPost(credentials, { text: "Maybe posted" });

      expect(statusPosts).toHaveLength(4);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
      expect(result.creditDisposition).toBe("hold");
    },
    EXHAUSTED_RETRY_TIMEOUT_MS,
  );

  test(
    "a definite 4xx rejection of the status POST is a refundable failure",
    async () => {
      statusPostResponse = () => json({ error: "Validation failed: Text can't be blank" }, 422);
      const result = await mastodonProvider.createPost(credentials, { text: "Rejected" });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBeUndefined();
      expect(result.creditDisposition).toBeUndefined();
      expect(result.error).toContain("422");
    },
    EXHAUSTED_RETRY_TIMEOUT_MS,
  );
});

describe("mastodonProvider.deletePost", () => {
  beforeEach(() => {
    statusPosts = [];
    statusPostResponse = null;
    deleteResponse = null;
    globalThis.fetch = stubMastodonInstance as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test(
    "an exhausted delete 5xx surfaces the raw error, not an unknown post outcome",
    async () => {
      deleteResponse = () => new Response("Service Unavailable", { status: 503 });
      const failure = mastodonProvider.deletePost(
        { accessToken: "token", instanceUrl: "https://mastodon.example" },
        "110000000000000001",
      );

      await expect(failure).rejects.toThrow("mastodon API error 503");
      await expect(failure).rejects.not.toThrow("may have been published");
    },
    EXHAUSTED_RETRY_TIMEOUT_MS,
  );

  test(
    "a delete rate limited after an unanswered attempt keeps the typed rate-limit error",
    async () => {
      let deletes = 0;
      deleteResponse = () => {
        deletes += 1;
        return deletes === 1
          ? new Response("Service Unavailable", { status: 503 })
          : new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "0" } });
      };
      const failure = mastodonProvider.deletePost(
        { accessToken: "token", instanceUrl: "https://mastodon.example" },
        "110000000000000001",
      );

      await expect(failure).rejects.toMatchObject({ rateLimited: true, platform: "mastodon" });
      await expect(failure).rejects.not.toThrow("may have been published");
      expect(deletes).toBe(4);
    },
    EXHAUSTED_RETRY_TIMEOUT_MS,
  );
});
