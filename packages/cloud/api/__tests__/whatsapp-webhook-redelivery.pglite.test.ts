/**
 * A WhatsApp message that was already answered must stay deduplicated after
 * the 2-minute processing claim would have expired. Meta redelivers a message
 * when it does not get a 200 in time; before this fix the redelivery ran a
 * second model turn and sent (and billed) a second reply. Twilio and Blooio
 * webhooks already keep the key for the delivered window.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-1111111111f2";
const AGENT = "22222222-2222-4222-8222-2222222222f2";
const USER = "33333333-3333-4333-8333-3333333333f2";

let modelTurns = 0;
let repliesSent = 0;

mock.module("@elizaos/cloud-shared/lib/services/whatsapp-automation", () => ({
  whatsappAutomationService: {
    verifyWebhookSignature: async () => true,
    verifyWebhookSubscription: async () => null,
    getAccessToken: async () => null,
    getPhoneNumberId: async () => null,
    getBusinessPhone: async () => "15550001111",
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routeWhatsAppMessage: async () => {
      modelTurns += 1;
      return {
        handled: true,
        agentId: AGENT,
        organizationId: ORG,
        userId: USER,
        replyText: "Hello from the agent",
      };
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/message-router", () => ({
  messageRouterService: {
    sendMessage: async () => {
      repliesSent += 1;
      return { status: "delivered" };
    },
    routeIncomingMessage: async () => ({ success: false }),
    processWithAgent: async () => null,
  },
}));

const { dbWrite, closeDatabaseConnectionsForTests, getPgliteClientForTests } =
  await import("@elizaos/cloud-shared/db/client");
const schema = await import("@elizaos/cloud-shared/db/schemas");
const { Hono } = await import("hono");
const { default: whatsappRoute } = await import(
  "../webhooks/whatsapp/[orgId]/route"
);

const app = new Hono().route("/api/webhooks/whatsapp/:orgId", whatsappRoute);
const env = {
  NODE_ENV: "test",
  RATE_LIMIT_DISABLED: "true",
  SKIP_WEBHOOK_VERIFICATION: "true",
};
const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

beforeAll(async () => {
  const { apply } = await pushSchema(
    { idempotencyKeys: schema.idempotencyKeys } as never,
    dbWrite as never,
  );
  await apply();
}, 180_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

function webhookBody(messageId: string) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "wa-business-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: "pn-1",
              },
              contacts: [{ profile: { name: "Ada" }, wa_id: "15550002222" }],
              messages: [
                {
                  id: messageId,
                  from: "15550002222",
                  timestamp: "1760000000",
                  type: "text",
                  text: { body: "What is on my calendar today?" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function deliver(messageId: string) {
  const response = await app.request(
    `/api/webhooks/whatsapp/${ORG}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: webhookBody(messageId),
    },
    env,
    executionCtx,
  );
  return response.status;
}

test("a redelivery after the processing claim expired is not answered again", async () => {
  expect(await deliver("wamid.first")).toBe(200);
  expect(modelTurns).toBe(1);
  expect(repliesSent).toBe(1);

  // Three minutes later: the 2-minute processing claim has expired.
  await getPgliteClientForTests().query(
    "UPDATE idempotency_keys SET expires_at = expires_at - interval '3 minutes'",
  );
  expect(await deliver("wamid.first")).toBe(200);
  expect(modelTurns).toBe(1);
  expect(repliesSent).toBe(1);

  // A different message is still processed.
  expect(await deliver("wamid.second")).toBe(200);
  expect(modelTurns).toBe(2);
  expect(repliesSent).toBe(2);
}, 60_000);
