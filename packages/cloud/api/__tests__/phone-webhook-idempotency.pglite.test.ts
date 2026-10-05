/**
 * Twilio and Blooio webhook routes claim each provider message atomically in
 * the real idempotency store (PGlite) before any agent routing (#31768).
 * Overlapping redeliveries of one message must route once; a failed delivery
 * must release its claim so the provider's retry can proceed. The agent
 * gateway is replaced by a slow counting router so overlap is guaranteed and
 * no inference, outbound send or usage row is attempted.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

let routed = 0;
let failNext = false;
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    RateLimitPresets: { AGGRESSIVE: {} },
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/twilio-automation", () => ({
  twilioAutomationService: { getAuthToken: async () => null },
}));
mock.module("@elizaos/cloud-shared/lib/services/blooio-automation", () => ({
  blooioAutomationService: {
    getWebhookSecret: async () => null,
    getApiKey: async () => null,
    getFromNumber: async () => null,
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routePhoneMessage: async () => {
      routed++;
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (failNext) {
        failNext = false;
        throw new Error("gateway unavailable");
      }
      return { handled: false, reason: "test_router" };
    },
  },
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { idempotencyKeys } = await import(
  "@elizaos/cloud-shared/db/schemas/idempotency-keys"
);
const twilio = (await import("../webhooks/twilio/[orgId]/route")).default;
const blooio = (await import("../webhooks/blooio/[orgId]/route")).default;

const app = new Hono();
app.route("/twilio/:orgId", twilio);
app.route("/blooio/:orgId", blooio);
const env = { NODE_ENV: "test", SKIP_WEBHOOK_VERIFICATION: "true" };
const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const orgId = randomUUID();

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
  routed = 0;
  failNext = false;
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

function twilioDelivery(messageSid: string) {
  const form = new URLSearchParams({
    MessageSid: messageSid,
    AccountSid: "AC_test",
    From: "+15550000001",
    To: "+15550000002",
    Body: "hello",
  });
  return app.request(
    `/twilio/${orgId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    env,
    executionCtx as never,
  );
}

function blooioDelivery(messageId: string) {
  return app.request(
    `/blooio/${orgId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message.received",
        message_id: messageId,
        sender: "+15550000001",
        text: "hello",
      }),
    },
    env,
    executionCtx as never,
  );
}

test("overlapping Twilio redeliveries of one MessageSid route once", async () => {
  const sid = `SM${randomUUID().replaceAll("-", "")}`;
  const responses = await Promise.all([
    twilioDelivery(sid),
    twilioDelivery(sid),
    twilioDelivery(sid),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(routed).toBe(1);
  expect((await twilioDelivery(sid)).status).toBe(200);
  expect(routed).toBe(1);
});

test("a failed Twilio delivery releases its claim so the retry routes", async () => {
  const sid = `SM${randomUUID().replaceAll("-", "")}`;
  failNext = true;
  expect((await twilioDelivery(sid)).status).toBe(500);
  expect((await twilioDelivery(sid)).status).toBe(200);
  expect(routed).toBe(2);
});

test("overlapping Blooio redeliveries of one message route once", async () => {
  const id = `msg_${randomUUID()}`;
  const responses = await Promise.all([
    blooioDelivery(id),
    blooioDelivery(id),
    blooioDelivery(id),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(routed).toBe(1);
});

test("a failed Blooio delivery releases its claim so the retry routes", async () => {
  const id = `msg_${randomUUID()}`;
  failNext = true;
  expect((await blooioDelivery(id)).status).toBe(500);
  expect((await blooioDelivery(id)).status).toBe(200);
  expect(routed).toBe(2);
});
