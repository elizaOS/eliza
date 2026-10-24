/**
 * POST /api/v1/telegram/scan-chats turns the org bot's webhook off to call
 * getUpdates, then turns it back on. Runs the real route, the real
 * TelegramAutomationService.setWebhook and real Telegraf against a local Bot
 * API double that keeps Telegram's pending-update queue. Proves updates that
 * arrive during a scan still reach the webhook, and that a failed restore is
 * not reported as success.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.ELIZA_API_URL = "https://api.example.test";

const ORG = "11111111-1111-4111-8111-1111111111a7";
const BOT_TOKEN = "123456789:scan-test-token";
const GROUP_ID = -100777;

type PendingUpdate = { update_id: number } & Record<string, unknown>;

const botApi = {
  webhookUrl: "https://api.example.test/api/v1/telegram/webhook/old",
  pending: [] as PendingUpdate[],
  deliveredToWebhook: [] as number[],
  failSetWebhook: false,
  nextUpdateId: 1,
};

function chatUpdate(kind: "my_chat_member" | "message"): PendingUpdate {
  const chat = { id: GROUP_ID, type: "supergroup", title: "Team" };
  const from = { id: 42, is_bot: false, first_name: "Ann" };
  const update_id = botApi.nextUpdateId++;
  if (kind === "message") {
    return {
      update_id,
      message: { message_id: update_id, date: 1, chat, from, text: "hi bot" },
    };
  }
  return {
    update_id,
    my_chat_member: {
      chat,
      from,
      date: 1,
      old_chat_member: { status: "left", user: from },
      new_chat_member: { status: "member", user: from },
    },
  };
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const method = new URL(request.url).pathname.split("/").pop();
    // Telegraf sends JSON bodies gzip-compressed.
    const raw = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(
      request.headers.get("content-encoding") === "gzip"
        ? Bun.gunzipSync(raw)
        : raw,
    );
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const ok = (result: unknown) => Response.json({ ok: true, result });
    switch (method) {
      case "deleteWebhook":
        botApi.webhookUrl = "";
        if (body.drop_pending_updates) botApi.pending = [];
        // A group member writes to the bot while the webhook is off.
        botApi.pending.push(chatUpdate("message"));
        return ok(true);
      case "getUpdates": {
        if (botApi.webhookUrl) {
          return Response.json(
            { ok: false, error_code: 409, description: "Conflict" },
            { status: 409 },
          );
        }
        const offset = Number(body.offset ?? 0);
        if (offset > 0) {
          botApi.pending = botApi.pending.filter((u) => u.update_id >= offset);
        }
        return ok(botApi.pending);
      }
      case "setWebhook":
        if (botApi.failSetWebhook) {
          return Response.json(
            {
              ok: false,
              error_code: 429,
              description: "Too Many Requests: retry after 5",
            },
            { status: 429 },
          );
        }
        botApi.webhookUrl = String(body.url);
        if (!body.drop_pending_updates) {
          botApi.deliveredToWebhook.push(
            ...botApi.pending.map((u) => u.update_id),
          );
        }
        botApi.pending = [];
        return ok(true);
      case "getMe":
        return ok({
          id: 123456789,
          is_bot: true,
          first_name: "Bot",
          username: "scan_test_bot",
        });
      case "getChatMember":
        return ok({
          status: "administrator",
          user: { id: 123456789, is_bot: true, first_name: "Bot" },
        });
      default:
        return Response.json(
          { ok: false, error_code: 404, description: `no ${method}` },
          { status: 404 },
        );
    }
  },
});

const realTelegraf = await import("telegraf");
mock.module("telegraf", () => ({
  ...realTelegraf,
  Telegraf: class extends realTelegraf.Telegraf {
    constructor(token: string) {
      super(token, {
        telegram: { apiRoot: `http://127.0.0.1:${server.port}` },
      });
    }
  },
}));

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: "44444444-4444-4444-8444-4444444444a7",
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
    role: "owner",
  }),
}));

const { telegramAutomationService } = await import(
  "@elizaos/cloud-shared/lib/services/telegram-automation"
);
const { telegramChatsRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/telegram-chats"
);
const storedChats: Array<Record<string, unknown>> = [];
Object.assign(telegramAutomationService, {
  getBotToken: async () => BOT_TOKEN,
  getWebhookSecret: async () => "webhook-secret",
});
Object.assign(telegramChatsRepository, {
  upsert: async (row: Record<string, unknown>) => {
    storedChats.push(row);
    return row;
  },
  findByOrganization: async () => storedChats,
});

const { Hono } = await import("hono");
const { default: scanRoute } = await import("../v1/telegram/scan-chats/route");
const app = new Hono().route("/api/v1/telegram/scan-chats", scanRoute);
const env = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

function scan() {
  return app.request(
    "/api/v1/telegram/scan-chats",
    { method: "POST" },
    env as never,
  );
}

beforeEach(() => {
  botApi.webhookUrl = "https://api.example.test/api/v1/telegram/webhook/old";
  botApi.deliveredToWebhook = [];
  botApi.failSetWebhook = false;
  // The bot was added to a group; Telegram keeps the update queued.
  botApi.pending = [chatUpdate("my_chat_member")];
  storedChats.length = 0;
});

afterAll(() => {
  server.stop(true);
});

test("a scan restores the webhook and keeps the updates that arrived during it", async () => {
  const pendingIds = botApi.pending.map((u) => u.update_id);
  const response = await scan();

  expect(response.status).toBe(200);
  const body = (await response.json()) as { newChatsFound: number };
  expect(body.newChatsFound).toBe(1);
  expect(botApi.webhookUrl).toBe(
    `https://api.example.test/api/v1/telegram/webhook/${ORG}`,
  );
  // The queued group-add update and the message written during the scan
  // both still reach the agent through the webhook.
  expect(botApi.deliveredToWebhook).toEqual([...pendingIds, pendingIds[0] + 1]);
});

test("a scan that cannot restore the webhook is not reported as success", async () => {
  botApi.failSetWebhook = true;
  const response = await scan();

  expect(botApi.webhookUrl).toBe("");
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ webhookSet: false });
});
