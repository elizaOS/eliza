/**
 * Meta redelivers a WhatsApp webhook when it gets no 200 in time, and may send
 * duplicates. The org webhook must answer a message once (one reply, one
 * bill), and must not answer 200 for a message it failed to process, or Meta
 * never redelivers it. Real webhook deliveries through the real idempotency
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
let failRouting = false;
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
      if (failRouting) throw new Error("router unavailable");
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
  failRouting = false;
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function deliver(orgId: string, messageId: string): Promise<number> {
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
                  id: messageId,
                  from: "15550000001",
                  timestamp: "1760000000",
                  type: "text",
                  text: { body: "is my order on the way?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const response = await app.request(
    `/whatsapp/${orgId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    { NODE_ENV: "test", SKIP_WEBHOOK_VERIFICATION: "true" },
    executionCtx as never,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  return response.status;
}

/** Ages every stored key, as if the given time had passed since delivery. */
async function minutesPass(minutes: number): Promise<void> {
  await getPgliteClientForTests().exec(
    `UPDATE idempotency_keys SET expires_at = expires_at - interval '${minutes} minutes'`,
  );
}

test("a Meta redelivery three minutes later is not answered again", async () => {
  const orgId = randomUUID();
  const messageId = `wamid.${randomUUID()}`;
  expect(await deliver(orgId, messageId)).toBe(200);
  await minutesPass(3);
  expect(await deliver(orgId, messageId)).toBe(200);
  expect(routed).toHaveLength(1);
});

test("a message that failed is not acknowledged and is answered on redelivery", async () => {
  const orgId = randomUUID();
  const messageId = `wamid.${randomUUID()}`;
  failRouting = true;
  expect(await deliver(orgId, messageId)).toBe(500);
  expect(routed).toEqual([]);

  failRouting = false;
  expect(await deliver(orgId, messageId)).toBe(200);
  expect(routed).toHaveLength(1);
});
