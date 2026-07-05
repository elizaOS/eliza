/**
 * Error-policy proof for the Telegram automation connector (#13415).
 *
 * Pins the fail-closed contract: an internal platform/API failure PROPAGATES as an
 * explicit typed failure and stays DISTINCT from a legitimately-empty/designed state
 * (not-configured, invalid-format) — a failed send never reads as "delivered", a failed
 * status check never reads as a clean success. Drives the real exported singleton with
 * Telegraf + the secrets store mocked; no source stubs stand in for the code under test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Per-test controllable Telegram API behavior.
let getMeImpl: () => Promise<{ id: number; username?: string; first_name: string }>;
let sendMessageImpl: (
  chatId: string | number,
  text: string,
  opts: unknown,
) => Promise<{ message_id: number }>;

mock.module("telegraf", () => ({
  Telegraf: class {
    telegram = {
      getMe: () => getMeImpl(),
      sendMessage: (chatId: string | number, text: string, opts: unknown) =>
        sendMessageImpl(chatId, text, opts),
      setWebhook: async () => ({}),
      deleteWebhook: async () => ({}),
    };
    constructor(public token: string) {}
  },
}));

// In-memory secrets store keyed by secret name (single org per test id keeps it flat).
const secretStore = new Map<string, string>();
mock.module("../secrets", () => ({
  secretsService: {
    get: async (_organizationId: string, name: string) => secretStore.get(name) ?? null,
    list: async () => [],
    create: async () => undefined,
    rotate: async () => undefined,
    delete: async () => undefined,
  },
}));

const { telegramAutomationService } = await import("./index");

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  secretStore.clear();
  // Any real network attempt must fail loudly — the connector is fully mocked, so a live
  // fetch would mean the test escaped its harness.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("unexpected real network call");
  }) as typeof globalThis.fetch;
  getMeImpl = async () => ({ id: 1, username: "bot", first_name: "Bot" });
  sendMessageImpl = async () => ({ message_id: 100 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sendMessage — outbound send fails closed", () => {
  test("designed 'not configured' (no token) returns explicit failure, never attempts a send", async () => {
    let sendAttempted = false;
    sendMessageImpl = async () => {
      sendAttempted = true;
      return { message_id: 1 };
    };

    const res = await telegramAutomationService.sendMessage("org-noconf", 42, "hi");

    expect(res.success).toBe(false);
    expect(res.error).toBe("Bot not configured");
    expect(res.messageId).toBeUndefined();
    expect(sendAttempted).toBe(false);
  });

  test("internal Telegram failure PROPAGATES as { success:false } — not a fabricated delivery", async () => {
    secretStore.set("TELEGRAM_BOT_TOKEN", "123:abc");
    sendMessageImpl = async () => {
      throw new Error("403: bot was blocked by the user");
    };

    const res = await telegramAutomationService.sendMessage("org-send-fail", 42, "hi");

    expect(res.success).toBe(false);
    expect(res.messageId).toBeUndefined();
    expect(res.error).toContain("bot was blocked");
  });

  test("a real delivery is the ONLY path that yields success:true + a messageId", async () => {
    secretStore.set("TELEGRAM_BOT_TOKEN", "123:abc");
    sendMessageImpl = async () => ({ message_id: 777 });

    const res = await telegramAutomationService.sendMessage("org-send-ok", 42, "hi");

    expect(res.success).toBe(true);
    expect(res.messageId).toBe(777);
    expect(res.error).toBeUndefined();
  });
});

describe("getConnectionStatus — internal failure stays distinct from designed-empty", () => {
  test("designed-empty: no stored token => not configured, NO error field", async () => {
    const status = await telegramAutomationService.getConnectionStatus("org-empty", {
      skipCache: true,
    });

    expect(status.configured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.error).toBeUndefined();
  });

  test("internal failure: token present but getMe throws => error field surfaces (distinct render)", async () => {
    secretStore.set("TELEGRAM_BOT_TOKEN", "123:abc");
    secretStore.set("TELEGRAM_BOT_USERNAME", "mybot");
    secretStore.set("TELEGRAM_BOT_ID", "555");
    getMeImpl = async () => {
      throw new Error("401 Unauthorized");
    };

    const status = await telegramAutomationService.getConnectionStatus("org-status-fail", {
      skipCache: true,
    });

    // configured stays true (credentials ARE stored) but the failure is observably flagged —
    // the populated `error` keeps this distinguishable from the designed not-configured empty.
    expect(status.configured).toBe(true);
    expect(typeof status.error).toBe("string");
    expect(status.error).toContain("reconnect");
  });

  test("healthy: getMe succeeds => connected with no error", async () => {
    secretStore.set("TELEGRAM_BOT_TOKEN", "123:abc");
    getMeImpl = async () => ({ id: 999, username: "livebot", first_name: "Live" });

    const status = await telegramAutomationService.getConnectionStatus("org-status-ok", {
      skipCache: true,
    });

    expect(status.connected).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.botId).toBe(999);
    expect(status.error).toBeUndefined();
  });
});

describe("validateBotToken — untrusted token verdict is explicit", () => {
  test("designed-invalid format returns { valid:false } without touching the API", async () => {
    let apiCalled = false;
    getMeImpl = async () => {
      apiCalled = true;
      return { id: 1, username: "bot", first_name: "Bot" };
    };

    const res = await telegramAutomationService.validateBotToken("no-colon-token");

    expect(res.valid).toBe(false);
    expect(res.error).toBe("Invalid token format");
    expect(apiCalled).toBe(false);
  });

  test("API failure PROPAGATES into the verdict as { valid:false, error } — distinct from format-invalid", async () => {
    getMeImpl = async () => {
      throw new Error("404: Not Found");
    };

    const res = await telegramAutomationService.validateBotToken("123:abc");

    expect(res.valid).toBe(false);
    expect(res.botInfo).toBeUndefined();
    expect(res.error).toContain("Not Found");
  });
});
