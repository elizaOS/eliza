import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { loadCanonicalMigrations } from "../../scripts/admin/canonical-migration-ledger";

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

const MIGRATION_TAG = "0536_twilio_sms_usage_billed_cost";
const canonicalMigrations = await loadCanonicalMigrations();
const billedCostMigration = canonicalMigrations.find(
  (migration) => migration.entry.tag === MIGRATION_TAG,
);
if (!billedCostMigration)
  throw new Error(`${MIGRATION_TAG} is absent from the canonical ledger`);

async function applyMigration(statements: string[]): Promise<void> {
  const client = getPgliteClientForTests();
  if (statements.some((statement) => /INDEX\s+CONCURRENTLY/i.test(statement))) {
    for (const statement of statements) await client.exec(statement);
    return;
  }
  await client.transaction(async (tx) => {
    for (const statement of statements) await tx.exec(statement);
  });
}

async function twilioInputCosts(): Promise<Record<string, string>> {
  const { rows } = await getPgliteClientForTests().query<{
    request_id: string;
    input_cost: string;
  }>(
    "SELECT request_id, input_cost FROM usage_records WHERE type = 'twilio_sms' ORDER BY request_id",
  );
  return Object.fromEntries(
    rows.map((row) => [row.request_id, row.input_cost]),
  );
}

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  for (const migration of canonicalMigrations) {
    if (migration.entry.tag === MIGRATION_TAG) continue;
    await applyMigration(migration.statements);
  }
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

test("a pre-deploy Twilio SMS row is converted once and a new webhook row is untouched", async () => {
  await getPgliteClientForTests().query(
    `INSERT INTO usage_records(organization_id,user_id,type,model,provider,input_cost,output_cost,markup,request_id,metadata)
     VALUES ($1,$2,'twilio_sms','twilio-sms','twilio','0.75','0','0.15','SM_pre_deploy',$3)`,
    [
      orgId,
      userId,
      JSON.stringify({
        channel: "sms",
        segments: 1,
        costPerSegment: 0.75,
        billing: {
          rawCost: 0.75,
          markup: 0.15,
          billedCost: 0.9,
          markupRate: 0.2,
          segments: 1,
          costPerSegment: 0.75,
        },
      }),
    ],
  );

  const form = new URLSearchParams({
    MessageSid: "SM_post_deploy",
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
  expect(await twilioInputCosts()).toEqual({
    SM_post_deploy: "0.900000",
    SM_pre_deploy: "0.750000",
  });

  await applyMigration(billedCostMigration.statements);
  expect(await twilioInputCosts()).toEqual({
    SM_post_deploy: "0.900000",
    SM_pre_deploy: "0.900000",
  });
  await applyMigration(billedCostMigration.statements);
  expect(await twilioInputCosts()).toEqual({
    SM_post_deploy: "0.900000",
    SM_pre_deploy: "0.900000",
  });

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
      rawCost: 1.5,
      markup: 0.3,
      billedCost: 1.8,
      recordCount: 2,
    },
  ]);
});
