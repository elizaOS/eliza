/**
 * Stripe-Connect webhook replay dedupe (#12227 L5). Stripe delivers
 * at-least-once; without an event-id dedupe a re-delivered `account.updated`
 * reapplies capability/status writes. The route now dedupes on `event.id` via
 * the REAL `webhookEventsRepository.tryCreate` (in-process PGlite). Signature
 * verification is the Stripe SDK's job (mocked, as in the main stripe webhook
 * test); the dedupe path is exercised for real. Second delivery must be a
 * no-op — the account mutation runs exactly once.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const CONNECT_EVENT = {
  id: "evt_conn_1",
  type: "account.updated",
  account: "acct_1",
  created: Math.floor(Date.now() / 1000),
  data: { object: { charges_enabled: true, payouts_enabled: true } },
};

const constructEventAsync = mock(async () => CONNECT_EVENT);
const updateByAccountId = mock(async () => undefined);
const mapConnectWebhookEvent = mock(() => ({
  ignored: false,
  accountId: "acct_1",
  status: "active",
  chargesEnabled: true,
  payoutsEnabled: true,
  payoutStatus: "ready",
}));

mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({ webhooks: { constructEventAsync } }),
  isStripeConfigured: () => true,
}));
mock.module(
  "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts",
  () => ({
    stripeConnectAccountsRepository: { updateByAccountId },
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/stripe-connect-payout", () => ({
  mapConnectWebhookEvent,
}));
mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: async () => undefined }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const PGLITE_TIMEOUT = 60_000;
let closeDb: (() => Promise<void>) | undefined;
let connectRoute: typeof import("./route").default;

const ENV = {
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
  NODE_ENV: "test",
};

function delivery() {
  const app = new Hono();
  app.route("/", connectRoute);
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "valid-signature",
      },
      body: JSON.stringify({ id: "evt_conn_1", type: "account.updated" }),
    }),
    ENV,
  );
}

beforeAll(async () => {
  const { dbWrite, closeDatabaseConnectionsForTests } = await import(
    "@/db/client"
  );
  closeDb = closeDatabaseConnectionsForTests;
  await dbWrite.execute(
    `CREATE TABLE IF NOT EXISTS webhook_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id text NOT NULL UNIQUE,
      provider text NOT NULL,
      event_type text,
      payload_hash text NOT NULL,
      source_ip text,
      processed_at timestamp NOT NULL DEFAULT now(),
      event_timestamp timestamp
    );`,
  );
  ({ default: connectRoute } = await import("./route"));
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("Stripe-Connect webhook — replay dedupe (L5)", () => {
  beforeEach(async () => {
    updateByAccountId.mockClear();
    mapConnectWebhookEvent.mockClear();
    const { dbWrite } = await import("@/db/client");
    await dbWrite.execute("DELETE FROM webhook_events;");
  });

  test("first delivery applies; a replay of the same event.id is a no-op", async () => {
    const first = await delivery();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ success: true });
    expect(updateByAccountId).toHaveBeenCalledTimes(1);

    const replay = await delivery();
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ duplicate: true });
    // The capability/status write must run exactly once.
    expect(updateByAccountId).toHaveBeenCalledTimes(1);
  });
});
