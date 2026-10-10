import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const orgId = randomUUID();
const userId = randomUUID();

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
mock.module("@elizaos/cloud-shared/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routePhoneMessage: async () => ({
      handled: true,
      userId,
      agentId: randomUUID(),
      organizationId: orgId,
      replyText: "Your table is booked for 7pm.",
    }),
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/message-router", () => ({
  messageRouterService: {
    sendMessage: async () => ({ status: "delivered" }),
  },
}));
mock.module("@elizaos/cloud-shared/lib/auth/admin", () => ({
  requireAdminWithResponse: async () => ({
    user: { id: "admin" },
    role: "super_admin",
  }),
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { idempotencyKeys } = await import(
  "@elizaos/cloud-shared/db/schemas/idempotency-keys"
);
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { apiKeys } = await import("@elizaos/cloud-shared/db/schemas/api-keys");
const { usageRecords } = await import(
  "@elizaos/cloud-shared/db/schemas/usage-records"
);
const twilio = (await import("../webhooks/twilio/[orgId]/route")).default;
const breakdown = (
  await import("../v1/admin/users/[userId]/billing/breakdown/route")
).default;

const app = new Hono();
app.route("/twilio/:orgId", twilio);
app.route("/admin/users/:userId/billing/breakdown", breakdown);
const env = {
  NODE_ENV: "test",
  SKIP_WEBHOOK_VERIFICATION: "true",
  TWILIO_SMS_COST_PER_SEGMENT_USD: "0.75",
};
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
    generateDrizzleJson(
      { idempotencyKeys, organizations, users, apiKeys, usageRecords },
      empty.id,
    ),
  ))
    await getPgliteClientForTests().exec(statement.replaceAll('"public".', ""));
  await getPgliteClientForTests().query(
    "INSERT INTO organizations(id,name,slug) VALUES ($1,'Local','local')",
    [orgId],
  );
  await getPgliteClientForTests().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,'subject_test','owner')",
    [userId, orgId],
  );
});
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a delivered Twilio SMS reply is reported at its marked-up charge in the admin breakdown", async () => {
  const form = new URLSearchParams({
    MessageSid: `SM${randomUUID().replaceAll("-", "")}`,
    AccountSid: "AC_test",
    From: "+15550000001",
    To: "+15550000002",
    Body: "Book a table for 7pm",
  });
  const webhook = await app.request(
    `/twilio/${orgId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    env,
    executionCtx as never,
  );
  expect(webhook.status).toBe(200);

  const response = await app.request(
    `/admin/users/${userId}/billing/breakdown`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    breakdown: Array<{
      type: string;
      rawCost: number;
      markup: number;
      billedCost: number;
      recordCount: number;
    }>;
  };
  const rounded = (value: number) => Math.round(value * 1e6) / 1e6;
  expect(
    body.breakdown.map((row) => ({
      type: row.type,
      rawCost: rounded(row.rawCost),
      markup: rounded(row.markup),
      billedCost: rounded(row.billedCost),
      recordCount: row.recordCount,
    })),
  ).toEqual([
    {
      type: "twilio_sms",
      rawCost: 0.75,
      markup: 0.15,
      billedCost: 0.9,
      recordCount: 1,
    },
  ]);
});
