// Pins the fail-closed error policy of the Discord provider (J1 transport boundaries).
// An internal transport failure (Discord error code / retries exhausted) must surface as a
// distinguishable { success:false } / { valid:false } result the socialMediaService caller
// inspects and refunds on — never as a fabricated success. Designed pre-flight guards
// (missing channelId / missing token) stay a distinct failure that never touches the network,
// and the real success path returns a real postId (drives the exported provider, not a
// tautology). Deterministic fetch fixtures; no live network. Backoff sleeps are collapsed so a
// retrying failure rejects promptly.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { discordProvider } = await import("./discord");

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const WEBHOOK_CREDS = { webhookUrl: "https://discord.com/api/webhooks/1/abc" } as never;
const BOT_CREDS = { botToken: "bot-token", channelId: "chan-1" } as never;
const BOT_CREDS_NO_CHANNEL = { botToken: "bot-token" } as never;
const CONTENT = { text: "hello world" } as never;

beforeEach(() => {
  // Collapse exponential-backoff sleeps so a failing request exhausts its retries and rejects
  // without waiting out the real delays.
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

describe("discordProvider error policy", () => {
  it("createPost surfaces an internal webhook transport failure as { success:false }, not a fabricated success", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      // Discord returns an error envelope with a `code`; the provider's parser throws on it,
      // withRetry exhausts retries, and the provider's J1 catch translates it to a failure.
      return jsonResponse({ code: 50035, message: "Invalid webhook token" });
    }) as typeof fetch;

    const result = await discordProvider.createPost(WEBHOOK_CREDS, CONTENT);

    expect(result.success).toBe(false);
    expect(result.platform).toBe("discord");
    expect(result.error).toContain("Invalid webhook token");
    expect(result.postId).toBeUndefined();
    // Proved the failure actually reached the network (and retried) rather than short-circuiting.
    expect(fetchCalls).toBeGreaterThan(0);
  });

  it("createPost returns a real postId on webhook success (drives the real path, not a tautology)", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ id: "msg-123", channel_id: "chan-9" }),
    ) as typeof fetch;

    const result = await discordProvider.createPost(WEBHOOK_CREDS, CONTENT);

    expect(result.success).toBe(true);
    expect(result.postId).toBe("msg-123");
    expect(result.postUrl).toContain("chan-9");
    expect(result.postUrl).toContain("msg-123");
  });

  it("createPost designed guard (bot token, no channelId) fails closed WITHOUT touching the network", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({ id: "should-not-happen", channel_id: "x" });
    }) as typeof fetch;

    const result = await discordProvider.createPost(BOT_CREDS_NO_CHANNEL, CONTENT);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Channel ID required for bot posting");
    // Distinct from a transport failure: the designed-invalid guard never hits the API.
    expect(fetchCalls).toBe(0);
  });

  it("validateCredentials surfaces a webhook transport failure as { valid:false }, never a false-valid", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const result = await discordProvider.validateCredentials(WEBHOOK_CREDS);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("network down");
    expect(result.accountId).toBeUndefined();
  });

  it("deletePost surfaces an internal bot-API failure as { success:false }, not a fabricated success", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ code: 10008, message: "Unknown Message" }),
    ) as typeof fetch;

    const result = await discordProvider.deletePost(BOT_CREDS, "chan-1/msg-1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown Message");
  });
});
