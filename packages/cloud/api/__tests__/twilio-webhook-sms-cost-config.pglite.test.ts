/**
 * The Twilio webhook bills a delivered reply at TWILIO_SMS_COST_PER_SEGMENT_USD
 * and must warn the operator exactly when that value is rejected and the
 * default is billed instead. Routing, the outbound send and the usage store
 * are replaced so the recorded per-segment cost and the warning are observed
 * from one real webhook delivery through the real idempotency store (PGlite).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const billedCosts: number[] = [];
const routedMessages: Array<{ mediaUrls?: string[]; mediaTypes?: string[] }> =
  [];
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
    routePhoneMessage: async (args: {
      mediaUrls?: string[];
      mediaTypes?: string[];
    }) => {
      routedMessages.push(args);
      return {
        handled: true,
        userId: randomUUID(),
        agentId: randomUUID(),
        organizationId: randomUUID(),
        replyText: "hi",
      };
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/message-router", () => ({
  messageRouterService: { sendMessage: async () => ({ status: "delivered" }) },
}));
mock.module("@elizaos/cloud-shared/lib/services/usage", () => ({
  usageService: {
    create: async (record: { metadata: { costPerSegment: number } }) => {
      billedCosts.push(record.metadata.costPerSegment);
    },
  },
}));

const { DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD } = await import(
  "@elizaos/cloud-shared/billing"
);
const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { idempotencyKeys } = await import(
  "@elizaos/cloud-shared/db/schemas/idempotency-keys"
);
const { logger } = await import("@elizaos/cloud-shared/lib/utils/logger");
const twilio = (await import("../webhooks/twilio/[orgId]/route")).default;

const INVALID_COST_WARNING =
  "[TwilioWebhook] Invalid TWILIO_SMS_COST_PER_SEGMENT_USD; using default";
const app = new Hono();
app.route("/twilio/:orgId", twilio);
const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const orgId = randomUUID();
const warn = spyOn(logger, "warn");

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
  billedCosts.length = 0;
  routedMessages.length = 0;
  warn.mockClear();
});
afterAll(async () => {
  warn.mockRestore();
  await closeDatabaseConnectionsForTests();
});

/** Delivers one inbound SMS; reports the billed cost and whether the operator was warned. */
async function deliver(
  configuredCost: string | undefined,
  extraFields: Record<string, string> = {},
) {
  const form = new URLSearchParams({
    MessageSid: `SM${randomUUID().replaceAll("-", "")}`,
    AccountSid: "AC_test",
    From: "+15550000001",
    To: "+15550000002",
    Body: "hello",
    ...extraFields,
  });
  const response = await app.request(
    `/twilio/${orgId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    {
      NODE_ENV: "test",
      SKIP_WEBHOOK_VERIFICATION: "true",
      TWILIO_SMS_COST_PER_SEGMENT_USD: configuredCost,
    },
    executionCtx as never,
  );
  expect(response.status).toBe(200);
  return {
    billedCosts: [...billedCosts],
    warned: warn.mock.calls.some(
      ([message]) => message === INVALID_COST_WARNING,
    ),
  };
}

for (const rejected of ["0.01USD", "0x10", "1e", "-0", "0.5.5", "-5"]) {
  test(`warns when rejected cost ${JSON.stringify(rejected)} bills the default`, async () => {
    expect(await deliver(rejected)).toEqual({
      billedCosts: [DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD],
      warned: true,
    });
  });
}

for (const [accepted, cost] of [
  ["0.01", 0.01],
  [" +0.02 ", 0.02],
  ["1e-2", 0.01],
  ["0", 0],
] as const) {
  test(`does not warn when cost ${JSON.stringify(accepted)} is billed as configured`, async () => {
    expect(await deliver(accepted)).toEqual({
      billedCosts: [cost],
      warned: false,
    });
  });
}

test("does not warn when the cost is not configured", async () => {
  expect(await deliver(undefined)).toEqual({
    billedCosts: [DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD],
    warned: false,
  });
});

test("passes the type of each MMS file to routing", async () => {
  const base =
    "https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages/MM1/Media";
  await deliver(undefined, {
    NumMedia: "2",
    MediaUrl0: `${base}/ME0`,
    MediaContentType0: "audio/amr",
    MediaUrl1: `${base}/ME1`,
    MediaContentType1: "application/pdf",
  });
  expect(routedMessages).toHaveLength(1);
  expect(routedMessages[0]).toMatchObject({
    mediaUrls: [`${base}/ME0`, `${base}/ME1`],
    mediaTypes: ["audio/amr", "application/pdf"],
  });
});
