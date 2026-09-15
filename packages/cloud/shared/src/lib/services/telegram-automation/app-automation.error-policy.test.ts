/**
 * Error-policy tests for the Telegram app-automation connector (#13415).
 *
 * Doctrine: a failed Telegram send is an internal transport failure and must
 * surface as a distinguishable `PostResult` failure (success:false + error),
 * never read as "delivered". These pin that a send that throws propagates into
 * success:false carrying the transport error, while the DESIGNED reject
 * (automation not enabled) and the success path stay distinct — so callers can
 * tell a broken send apart from a legitimately-skipped post and a real post.
 *
 * The real exported `postAnnouncement` is driven; only its collaborators
 * (Telegram SDK, bot-token lookup, app repo) are mocked, and `text` is passed
 * so no credit/LLM generation runs.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-00000000c001";
const APP_ID = "00000000-0000-4000-8000-00000000c002";

// Controls how the mocked Telegram sendMessage behaves for the current test.
let sendBehavior: () => Promise<{ message_id: number }> = async () => ({ message_id: 1 });
const sendMessageCalls: unknown[][] = [];
const sendPhotoCalls: unknown[][] = [];

mock.module("telegraf", () => ({
  Telegraf: class {
    telegram = {
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return sendBehavior();
      },
      sendPhoto: (...args: unknown[]) => {
        sendPhotoCalls.push(args);
        return sendBehavior();
      },
    };
  },
}));

mock.module("./index", () => ({
  telegramAutomationService: {
    getBotToken: async () => "TELEGRAM_BOT_TOKEN",
    isConfigured: async () => true,
    getConnectionStatus: async () => ({ connected: true }),
  },
}));

const updateCalls: unknown[] = [];
function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    organization_id: ORG_ID,
    name: "Test App",
    description: "An app under test",
    app_url: "https://test-app.example",
    website_url: "https://test-app.example",
    promotional_assets: undefined,
    telegram_automation: { enabled: true, channelId: "chan-123" },
    ...overrides,
  };
}
let appFixture = makeApp();

mock.module("../../../db/repositories/apps", () => ({
  appsRepository: {
    findById: async () => appFixture,
    update: async (_id: string, patch: unknown) => {
      updateCalls.push(patch);
      return appFixture;
    },
  },
}));

mock.module("../character-prompt-helper", () => ({
  getCharacterPromptContext: async () => null,
  buildCharacterSystemPrompt: () => "IN CHARACTER",
}));

const { telegramAppAutomationService } = await import("./app-automation");

const originalFetch = globalThis.fetch;
beforeEach(() => {
  updateCalls.length = 0;
  sendMessageCalls.length = 0;
  sendPhotoCalls.length = 0;
  appFixture = makeApp();
  sendBehavior = async () => ({ message_id: 1 });
  globalThis.fetch = (async () => {
    throw new Error("network access not allowed in this test");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("postAnnouncement error policy (#13415)", () => {
  test("Telegram send transport failure propagates as distinguishable success:false", async () => {
    sendBehavior = async () => {
      throw new Error("ETELEGRAM 429 too many requests");
    };

    const result = await telegramAppAutomationService.postAnnouncement(
      ORG_ID,
      APP_ID,
      "hello world",
    );

    // Internal failure surfaces — NOT fabricated as delivered.
    expect(result.success).toBe(false);
    expect(result.error).toContain("ETELEGRAM 429 too many requests");
    expect(result.messageId).toBeUndefined();
    // A failed send must not bump the sent-message counter.
    expect(updateCalls).toHaveLength(0);
  });

  test("designed reject (automation disabled) stays distinct from transport failure", async () => {
    appFixture = makeApp({ telegram_automation: { enabled: false, channelId: "chan-123" } });

    const result = await telegramAppAutomationService.postAnnouncement(
      ORG_ID,
      APP_ID,
      "hello world",
    );

    expect(result.success).toBe(false);
    // Distinguishable from a transport error: a designed, not-a-crash reason.
    expect(result.error).toBe("Automation not enabled for this app");
    expect(updateCalls).toHaveLength(0);
  });

  test("successful send is not conflated with the failure branch", async () => {
    sendBehavior = async () => ({ message_id: 4242 });

    const result = await telegramAppAutomationService.postAnnouncement(
      ORG_ID,
      APP_ID,
      "hello world",
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe(4242);
    expect(result.error).toBeUndefined();
    // Only a real delivery bumps the counter.
    expect(updateCalls).toHaveLength(1);
  });

  test("a promotional image never turns the generated message into a truncated caption", async () => {
    appFixture = makeApp({
      promotional_assets: [
        {
          url: "https://cdn.example.test/promo.png",
          type: "banner",
          size: { width: 1200, height: 630 },
        },
      ],
    });
    const text = `${"complete ".repeat(1_000)}END_SENTINEL`;

    const result = await telegramAppAutomationService.postAnnouncement(ORG_ID, APP_ID, text);

    expect(result.success).toBe(true);
    expect(sendPhotoCalls).toHaveLength(1);
    expect(sendPhotoCalls[0]?.[2]).toBeUndefined();
    expect(sendMessageCalls.length).toBeGreaterThan(1);
    expect(sendMessageCalls.map((call) => String(call[1])).join("")).toBe(text);
  });
});
