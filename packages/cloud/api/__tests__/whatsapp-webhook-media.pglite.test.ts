/**
 * The WhatsApp org webhook must not drop a photo, video, voice note or
 * document: the turn reaches the agent with the caption and a note of what
 * was sent. One real webhook delivery per case through the real idempotency
 * store (PGlite); routing and the WhatsApp account service are replaced.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const routed: Array<{ body: string }> = [];
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    RateLimitPresets: { AGGRESSIVE: {} },
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/whatsapp-automation", () => ({
  whatsappAutomationService: {
    verifyWebhookSignature: async () => true,
    getAccessToken: async () => null,
    getPhoneNumberId: async () => "PNID",
    getBusinessPhone: async () => "+15550000002",
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routeWhatsAppMessage: async (args: { body: string }) => {
      routed.push(args);
      return { handled: false, reason: "test" };
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/message-router", () => ({
  messageRouterService: { routeIncomingMessage: async () => true },
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { idempotencyKeys } = await import(
  "@elizaos/cloud-shared/db/schemas/idempotency-keys"
);
const whatsapp = (await import("../webhooks/whatsapp/[orgId]/route")).default;

const app = new Hono();
app.route("/whatsapp/:orgId", whatsapp);
const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ idempotencyKeys }, empty.id),
  ))
    await getPgliteClientForTests().exec(statement.replaceAll('"public".', ""));
});
beforeEach(() => {
  routed.length = 0;
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function deliver(message: Record<string, unknown>) {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550000002",
                phone_number_id: "PNID",
              },
              contacts: [{ profile: { name: "Ana" }, wa_id: "15550000001" }],
              messages: [
                {
                  id: `wamid.${randomUUID()}`,
                  from: "15550000001",
                  timestamp: "1760000000",
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const response = await app.request(
    `/whatsapp/${randomUUID()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    { NODE_ENV: "test", SKIP_WEBHOOK_VERIFICATION: "true" },
    executionCtx as never,
  );
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("a captioned photo reaches the agent with its caption and a photo note", async () => {
  await deliver({
    type: "image",
    image: {
      id: "MEDIA1",
      mime_type: "image/jpeg",
      caption: "what plant is this?",
    },
  });
  expect(routed.map((args) => args.body)).toEqual([
    "what plant is this?\n[The user sent a photo on WhatsApp. This connector cannot open WhatsApp media yet.]",
  ]);
});

test("a voice note reaches the agent instead of being dropped", async () => {
  await deliver({
    type: "audio",
    audio: { id: "MEDIA2", mime_type: "audio/ogg" },
  });
  expect(routed.map((args) => args.body)).toEqual([
    "[The user sent a voice note on WhatsApp. This connector cannot open WhatsApp media yet.]",
  ]);
});

test("a message type without text or media is still skipped", async () => {
  await deliver({ type: "location" });
  expect(routed).toEqual([]);
});
