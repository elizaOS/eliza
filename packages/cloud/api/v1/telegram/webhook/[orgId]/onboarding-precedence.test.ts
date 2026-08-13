/**
 * Exercises unknown-sender onboarding and app-automation precedence through
 * the real per-organization Telegram webhook handler with a deterministic bot
 * transport harness.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const replies: string[] = [];
interface TestMessage {
  message_id: number;
  text: string;
  chat: { id: number; type: "private" };
  from: { id: number; first_name: string; username: string };
}

interface TestContext {
  message: TestMessage;
  chat: TestMessage["chat"];
  from: TestMessage["from"];
  reply(text: string): Promise<void>;
}

interface TestApp {
  id: string;
  name: string;
  telegram_automation: { channelId: string; autoReply: boolean };
}

let textHandler: ((context: TestContext) => Promise<void>) | undefined;

class FakeTelegraf {
  telegram = {
    getMe: mock(async () => ({ id: 42 })),
    getChatMember: mock(async () => ({ status: "member" })),
  };

  start() {}
  help() {}
  command() {}
  on(event: string, handler: (context: TestContext) => Promise<void>) {
    if (event === "text") textHandler = handler;
  }

  async handleUpdate(update: { message?: TestMessage }) {
    const message = update.message;
    if (!message || !textHandler) return;
    await textHandler({
      message,
      chat: message.chat,
      from: message.from,
      reply: async (text: string) => {
        replies.push(text);
      },
    });
  }
}

mock.module("telegraf", () => ({ Telegraf: FakeTelegraf }));

const activeApps = mock(async () => [] as TestApp[]);
const handleIncomingMessage = mock(async () => undefined);
mock.module("@/lib/services/telegram-automation/app-automation", () => ({
  telegramAppAutomationService: {
    getAppsWithActiveAutomation: activeApps,
    handleIncomingMessage,
  },
}));

mock.module("@/lib/services/telegram-automation", () => ({
  telegramAutomationService: {
    getWebhookSecret: mock(async () => "webhook-secret"),
    getBotToken: mock(async () => "bot-token"),
  },
}));

interface TestRouteResult {
  handled: boolean;
  reason: "unknown_owner";
  replyText?: string;
}

const routeTelegramMessage = mock(
  async (): Promise<TestRouteResult> => ({
    handled: true,
    reason: "unknown_owner",
    replyText: "Connect your Eliza account",
  }),
);
mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: { routeTelegramMessage },
}));

mock.module("@/db/repositories/telegram-chats", () => ({
  telegramChatsRepository: {
    findByChatId: mock(async () => undefined),
    upsert: mock(async () => undefined),
    delete: mock(async () => undefined),
  },
}));

mock.module("@/db/repositories/webhook-events", () => ({
  webhookEventsRepository: {
    tryCreate: mock(async () => ({ created: true, event: { id: "event" } })),
    deleteByEventId: mock(async () => undefined),
  },
}));

mock.module("@/lib/auth/cron", () => ({
  timingSafeEqualSecret: (left: string, right: string) => left === right,
}));
mock.module("@/lib/api/hono-next-style-params", () => ({
  nextStyleParams: (context: {
    req: { param: (name: string) => string | undefined };
  }) => ({
    params: Promise.resolve({ orgId: context.req.param("orgId") ?? "" }),
  }),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (context: {
    json: (body: unknown, status: number) => Response;
  }) => context.json({ error: "internal" }, 500),
}));
mock.module("@/lib/utils/telegram-helpers", () => ({
  isCommand: (text: string) => text.startsWith("/"),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: "aggressive" },
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) =>
    await next(),
}));

const { default: telegramRoute } = await import("./route");

function appAutomation(autoReply: boolean) {
  return {
    id: "app-1",
    name: "Configured app",
    telegram_automation: { channelId: "555", autoReply },
  };
}

async function deliver(): Promise<Response> {
  const app = new Hono();
  app.route("/:orgId", telegramRoute);
  return await app.fetch(
    new Request("https://api.example.test/org-1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret",
      },
      body: JSON.stringify({
        update_id: 1001,
        message: {
          message_id: 7,
          date: 0,
          chat: { id: 555, type: "private" },
          from: { id: 555, first_name: "Shaw", username: "shaw" },
          text: "hello",
        },
      }),
    }),
  );
}

describe("per-organization Telegram first-contact precedence", () => {
  beforeEach(() => {
    replies.length = 0;
    textHandler = undefined;
    activeApps.mockReset();
    activeApps.mockResolvedValue([]);
    handleIncomingMessage.mockClear();
    routeTelegramMessage.mockClear();
    routeTelegramMessage.mockResolvedValue({
      handled: true,
      reason: "unknown_owner",
      replyText: "Connect your Eliza account",
    });
  });

  test("a matching active autoReply app retains precedence", async () => {
    activeApps.mockResolvedValue([appAutomation(true)]);
    routeTelegramMessage.mockResolvedValue({
      handled: false,
      reason: "unknown_owner",
      replyText: undefined,
    });

    expect((await deliver()).status).toBe(200);

    expect(routeTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ onboardUnknownOwner: false }),
    );
    expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    expect(replies).toEqual([]);
  });

  test("an unknown sender with no matching app receives onboarding", async () => {
    expect((await deliver()).status).toBe(200);

    expect(routeTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ onboardUnknownOwner: true }),
    );
    expect(handleIncomingMessage).not.toHaveBeenCalled();
    expect(replies).toEqual(["Connect your Eliza account"]);
  });

  test("a matching app without autoReply no longer leaves first contact silent", async () => {
    activeApps.mockResolvedValue([appAutomation(false)]);

    expect((await deliver()).status).toBe(200);

    expect(routeTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ onboardUnknownOwner: true }),
    );
    expect(handleIncomingMessage).not.toHaveBeenCalled();
    expect(replies).toEqual(["Connect your Eliza account"]);
  });
});
