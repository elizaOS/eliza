/**
 * An org Telegram bot delivers an agent reply longer than Telegram's 4096
 * character message limit as ordered parts, and acknowledges the update once
 * the turn has run, even when a part fails. The
 * real route and Telegraf client run; the Telegram Bot API is a local fake
 * that rejects an over-long message as the real one does, and the agent
 * gateway returns a fixed long reply.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

process.env.NODE_ENV = "test";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const longReply = Array.from(
  { length: 120 },
  (_, index) => `Line ${index + 1} of the weekly report, with its details.`,
).join("\n");
let routed = 0;
// When set, the fake Bot API rejects every send after this many accepted ones.
let acceptedBeforeRateLimit: number | null = null;

mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    RateLimitPresets: { AGGRESSIVE: {} },
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/telegram-automation", () => ({
  telegramAutomationService: {
    getWebhookSecret: async () => "webhook-secret",
    getBotToken: async () => "123456:test-token",
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/telegram-automation/app-automation",
  () => ({
    telegramAppAutomationService: {
      getAppsWithActiveAutomation: async () => [],
    },
  }),
);
const seenEvents = new Set<string>();
mock.module("@elizaos/cloud-shared/db/repositories/webhook-events", () => ({
  webhookEventsRepository: {
    tryCreate: async ({ event_id }: { event_id: string }) => {
      if (seenEvents.has(event_id)) return { created: false };
      seenEvents.add(event_id);
      return { created: true };
    },
    deleteByEventId: async (eventId: string) => {
      seenEvents.delete(eventId);
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routeTelegramMessage: async () => {
      routed += 1;
      return { handled: true, replyText: longReply };
    },
  },
}));

const sent: string[] = [];
const fakeTelegramApi = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = url.split("/").pop();
  if (method !== "sendMessage") {
    return Response.json({ ok: true, result: true });
  }
  const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
  if (
    acceptedBeforeRateLimit !== null &&
    sent.length >= acceptedBeforeRateLimit
  ) {
    return Response.json(
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 3",
        parameters: { retry_after: 3 },
      },
      { status: 429 },
    );
  }
  if (body.text.length > TELEGRAM_MESSAGE_LIMIT) {
    return Response.json(
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: message is too long",
      },
      { status: 400 },
    );
  }
  sent.push(body.text);
  return Response.json({
    ok: true,
    result: {
      message_id: sent.length,
      date: 0,
      chat: { id: 42, type: "private" },
    },
  });
}) as typeof fetch;
// Telegraf calls the Bot API through node-fetch.
mock.module("node-fetch", () => ({ default: fakeTelegramApi }));

const route = (await import("../v1/telegram/webhook/[orgId]/route")).default;
const app = new Hono();
app.route("/telegram/:orgId", route);

beforeEach(() => {
  routed = 0;
  acceptedBeforeRateLimit = null;
  sent.length = 0;
  seenEvents.clear();
});

function deliverUpdate(orgId: string) {
  return app.request(`/telegram/${orgId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": "webhook-secret",
    },
    body: JSON.stringify({
      update_id: 1001,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: 42, type: "private", first_name: "Owner" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        text: "Draft my weekly report.",
      },
    }),
  });
}

test("a reply longer than one Telegram message is delivered in order and the update is acknowledged", async () => {
  expect(longReply.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);
  const response = await deliverUpdate(randomUUID());

  expect(response.status).toBe(200);
  expect(routed).toBe(1);
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.join("")).toBe(longReply);
});

test("a later part that fails after earlier parts arrived does not re-run the turn", async () => {
  acceptedBeforeRateLimit = 1;
  const orgId = randomUUID();
  const first = await deliverUpdate(orgId);
  expect(first.status).toBe(200);
  expect(routed).toBe(1);
  expect(sent).toHaveLength(1);

  // Telegram does not redeliver an acknowledged update; a stray redelivery
  // is a duplicate and routes no second turn.
  acceptedBeforeRateLimit = null;
  const again = await deliverUpdate(orgId);
  expect(again.status).toBe(200);
  expect(routed).toBe(1);
  expect(sent).toHaveLength(1);
});

test("a first part that fails after the turn ran does not re-run the turn", async () => {
  acceptedBeforeRateLimit = 0;
  const orgId = randomUUID();
  const first = await deliverUpdate(orgId);
  expect(first.status).toBe(200);
  expect(routed).toBe(1);
  expect(sent).toHaveLength(0);

  // A redelivery of the same update_id is a duplicate: no second turn and no
  // part sent twice.
  acceptedBeforeRateLimit = null;
  const again = await deliverUpdate(orgId);
  expect(again.status).toBe(200);
  expect(routed).toBe(1);
  expect(sent).toHaveLength(0);
});
