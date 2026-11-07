/**
 * Drives the Stripe Connect webhook route against a PGlite database built from
 * the Drizzle schema, with signed events. Stripe does not deliver events in
 * order, so an older `account.updated` snapshot can arrive after a newer one;
 * the route must apply the account's current state. A failed apply must not
 * leave the dedupe marker behind, or Stripe's retry is skipped as a duplicate.
 */
import {
  afterAll,
  beforeAll,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_connect_webhook";
setDefaultTimeout(60_000);

const WEBHOOK_SECRET = "whsec_connect_test";

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { stripeConnectAccounts, stripeConnectStatusEnum, webhookEvents } =
  await import("@elizaos/cloud-shared/db/schemas");
const { stripeConnectAccountsRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts"
);
const { requireStripe } = await import("@elizaos/cloud-shared/lib/stripe");
const { default: router } = await import(
  "../v1/earnings/payout/stripe-connect/webhook/route"
);

const pg = () => getPgliteClientForTests();
const stripe = requireStripe();

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        organizations,
        users,
        stripeConnectStatusEnum,
        stripeConnectAccounts,
        webhookEvents,
      },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function connectedAccount(state: { payouts: boolean; charges: boolean }) {
  const org = randomUUID();
  const user = randomUUID();
  const accountId = `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Affiliate',$2,'0')",
    [org, `affiliate-${org}`],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [user, org, `subject_${user}`],
  );
  await pg().query(
    `INSERT INTO stripe_connect_accounts(user_id,stripe_connect_account_id,status,charges_enabled,payouts_enabled)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      user,
      accountId,
      state.payouts && state.charges ? "active" : "restricted",
      state.charges,
      state.payouts,
    ],
  );
  return { user, accountId };
}

async function deliver(
  accountId: string,
  snapshot: { payouts: boolean; charges: boolean },
  eventId = `evt_${randomUUID().replaceAll("-", "")}`,
) {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: "account.updated",
    account: accountId,
    created: Math.floor(Date.now() / 1000) - 60,
    data: {
      object: {
        id: accountId,
        object: "account",
        charges_enabled: snapshot.charges,
        payouts_enabled: snapshot.payouts,
      },
    },
  });
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: WEBHOOK_SECRET,
  });
  const response = await router.request(
    "/",
    {
      method: "POST",
      headers: {
        "stripe-signature": signature,
        "content-type": "application/json",
      },
      body: payload,
    },
    {
      NODE_ENV: "test",
      RATE_LIMIT_DISABLED: "true",
      STRIPE_CONNECT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  );
  return { response, eventId };
}

function liveAccount(state: { payouts: boolean; charges: boolean }) {
  return spyOn(stripe.accounts, "retrieve").mockResolvedValue({
    object: "account",
    charges_enabled: state.charges,
    payouts_enabled: state.payouts,
  } as never);
}

test("a late, older account.updated snapshot does not undo the account's current payout state", async () => {
  const { user, accountId } = await connectedAccount({
    payouts: true,
    charges: true,
  });
  const retrieve = liveAccount({ payouts: true, charges: true });
  try {
    // Snapshot from before onboarding finished, delivered after the newer one.
    const { response } = await deliver(accountId, {
      payouts: false,
      charges: false,
    });
    expect(response.status).toBe(200);
    const row = await stripeConnectAccountsRepository.findByUserId(user);
    expect({ status: row?.status, payouts: row?.payouts_enabled }).toEqual({
      status: "active",
      payouts: true,
    });
    expect(retrieve).toHaveBeenCalledWith(accountId);
  } finally {
    retrieve.mockRestore();
  }
});

test("a failed apply removes the dedupe marker so Stripe's retry is applied", async () => {
  const { user, accountId } = await connectedAccount({
    payouts: false,
    charges: false,
  });
  const retrieve = liveAccount({ payouts: true, charges: true });
  const outage = spyOn(
    stripeConnectAccountsRepository,
    "updateByAccountId",
  ).mockRejectedValueOnce(new Error("database unavailable"));
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  try {
    const first = await deliver(
      accountId,
      { payouts: true, charges: true },
      eventId,
    );
    expect(first.response.status).toBeGreaterThanOrEqual(500);
  } finally {
    outage.mockRestore();
  }
  const marker = await pg().query(
    "SELECT 1 FROM webhook_events WHERE event_id = $1",
    [`stripe-connect:${eventId}`],
  );
  expect(marker.rows).toHaveLength(0);

  try {
    // Stripe retries the same event.
    const { response } = await deliver(
      accountId,
      { payouts: true, charges: true },
      eventId,
    );
    expect((await response.json()) as unknown).toEqual({ success: true });
  } finally {
    retrieve.mockRestore();
  }
  const row = await stripeConnectAccountsRepository.findByUserId(user);
  expect(row?.payouts_enabled).toBe(true);
});
