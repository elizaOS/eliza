// Pins the fail-closed error policy of the Telegram provider. An upstream Bot API failure
// (transport reject or a `{ ok:false }` payload) is translated at the J1 boundary into the
// typed failure DTO the multi-platform caller reads to drive credit refunds — never a
// fabricated `valid:true` / `success:true`. The designed missing-credential guard is a
// distinct short-circuit that performs zero fetch, keeping "not configured" separable from
// "the call failed". Deterministic fetch fixtures drive the real exported provider; no live
// network. Backoff sleeps are collapsed so a retrying failure rejects promptly.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { telegramProvider } = await import("./telegram");

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return String(input);
}

const CREDS = { botToken: "123:abc" } as never;
const NO_CREDS = {} as never;

beforeEach(() => {
  // Collapse rate-limit / retry backoff so a failing request rejects without waiting out
  // the real exponential-backoff delays inside withRetry.
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

describe("telegramProvider error policy", () => {
  it("validateCredentials short-circuits to { valid:false } with zero fetch when the bot token is absent (designed 'not configured')", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({ ok: true, result: {} });
    }) as typeof fetch;

    const result = await telegramProvider.validateCredentials(NO_CREDS);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Bot token required");
    expect(fetchCalls).toBe(0);
  });

  it("validateCredentials never fabricates valid:true from an upstream getMe failure (fail-closed boundary translation)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async (input: unknown) => {
      fetchCalls++;
      expect(urlOf(input)).toContain("getMe");
      // Telegram returns HTTP 200 with an { ok:false } envelope on auth failure.
      return jsonResponse({ ok: false, description: "Unauthorized", error_code: 401 });
    }) as typeof fetch;

    const result = await telegramProvider.validateCredentials(CREDS);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Unauthorized");
    // The failure genuinely reached the network (distinct from the no-token short-circuit).
    expect(fetchCalls).toBeGreaterThan(0);
  });

  it("validateCredentials returns real account identity on success (drives the real reader, not a tautology)", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        ok: true,
        result: { id: 42, is_bot: true, first_name: "Botty", username: "botty_bot" },
      }),
    ) as typeof fetch;

    const result = await telegramProvider.validateCredentials(CREDS);

    expect(result.valid).toBe(true);
    expect(result.accountId).toBe("42");
    expect(result.username).toBe("botty_bot");
    expect(result.displayName).toBe("Botty");
  });

  it("createPost translates an upstream sendMessage failure into { success:false } — never a fabricated success the refund path would skip", async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      expect(urlOf(input)).toContain("sendMessage");
      return jsonResponse({ ok: false, description: "chat not found", error_code: 400 });
    }) as typeof fetch;

    const result = await telegramProvider.createPost(CREDS, { text: "hello" }, {
      telegram: { chatId: "999" },
    } as never);

    expect(result.success).toBe(false);
    expect(result.platform).toBe("telegram");
    expect(result.error).toBe("chat not found");
  });

  it("createPost short-circuits to { success:false } with zero fetch when chatId is missing (designed guard, distinct from a call failure)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({ ok: true, result: {} });
    }) as typeof fetch;

    const result = await telegramProvider.createPost(CREDS, { text: "hi" }, {} as never);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Chat ID required");
    expect(fetchCalls).toBe(0);
  });

  it("createPost returns a real postId on a successful send", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        ok: true,
        result: { message_id: 7, chat: { id: 999, type: "private" }, text: "hi" },
      }),
    ) as typeof fetch;

    const result = await telegramProvider.createPost(CREDS, { text: "hi" }, {
      telegram: { chatId: "999" },
    } as never);

    expect(result.success).toBe(true);
    expect(result.postId).toBe("7");
    expect(result.metadata).toEqual({ chatId: 999 });
  });
});
