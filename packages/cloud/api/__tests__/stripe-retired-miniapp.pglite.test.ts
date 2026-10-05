/**
 * Drives the real Stripe queue consumer and real credits service against a
 * PGlite database built from the Drizzle schema. Mini-app charges were retired
 * (#32021): a late or replayed Stripe delivery that still carries mini-app
 * metadata must be acknowledged without any org credit, never fulfilled as a
 * generic balance top-up. A one-time control proves the same shape without
 * the markers still credits, so the assertions cannot pass vacuously.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import type Stripe from "stripe";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { creditTransactions } = await import(
  "@elizaos/cloud-shared/db/schemas/credit-transactions"
);
const { organizationPaymentReversalHolds } = await import(
  "@elizaos/cloud-shared/db/schemas/organization-payment-reversal-holds"
);
const { invoices } = await import("@elizaos/cloud-shared/db/schemas/invoices");
const { processStripeEvent } = await import("../src/queue/stripe-event");

const pg = () => getPgliteClientForTests();

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        organizations,
        users,
        creditTransactions,
        invoices,
        organizationPaymentReversalHolds,
      },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

interface Buyer {
  org: string;
  user: string;
  paymentIntentId: string;
}

async function buyer(balance = "0"): Promise<Buyer> {
  const org = randomUUID();
  const user = randomUUID();
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Buyer',$2,$3)",
    [org, `buyer-${org}`, balance],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [user, org, `subject_${user}`],
  );
  return { org, user, paymentIntentId: `pi_${org.replaceAll("-", "")}` };
}

function miniappMetadata(target: Buyer, extra: Record<string, string> = {}) {
  return {
    type: "app_credit_purchase",
    source: "miniapp_app",
    app_id: randomUUID(),
    charge_request_id: randomUUID(),
    user_id: target.user,
    organization_id: target.org,
    credits: "5.00",
    amount: "5.00",
    ...extra,
  };
}

function delivery(type: string, object: Record<string, unknown>) {
  const eventId = `evt_${randomUUID()}`;
  return {
    attempts: 1,
    body: {
      kind: "stripe.event" as const,
      eventId,
      eventType: type,
      receivedAt: Date.now(),
      event: {
        id: eventId,
        type,
        livemode: false,
        api_version: "2024-11-20.acacia",
        data: { object },
      } as unknown as Stripe.Event,
    },
  };
}

function paymentIntentSucceeded(
  target: Buyer,
  metadata: Record<string, string>,
) {
  return delivery("payment_intent.succeeded", {
    id: target.paymentIntentId,
    object: "payment_intent",
    // Acacia one-time payment: explicit null invoice, no provider lookup.
    invoice: null,
    amount: 500,
    amount_received: 500,
    currency: "usd",
    customer: "cus_buyer",
    metadata,
  });
}

function checkoutSessionCompleted(
  target: Buyer,
  metadata: Record<string, string>,
) {
  return delivery("checkout.session.completed", {
    id: `cs_${target.org.replaceAll("-", "")}`,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    payment_intent: target.paymentIntentId,
    amount_total: 500,
    currency: "usd",
    customer: "cus_buyer",
    metadata,
  });
}

async function creditRows(org: string): Promise<number> {
  const rows = await pg().query<{ count: number }>(
    "SELECT count(*)::int AS count FROM credit_transactions WHERE organization_id=$1",
    [org],
  );
  return rows.rows[0]?.count ?? -1;
}

async function balance(org: string): Promise<number> {
  const rows = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [org],
  );
  return Number(rows.rows[0]?.credit_balance);
}

test("control: a one-time payment_intent.succeeded without mini-app markers credits the org", async () => {
  const target = await buyer();
  expect(
    await processStripeEvent(
      paymentIntentSucceeded(target, {
        type: "one_time",
        organization_id: target.org,
        credits: "5.00",
      }),
    ),
  ).toBe("ack");
  expect(await creditRows(target.org)).toBe(1);
  expect(await balance(target.org)).toBe(5);
});

test("a legacy mini-app payment_intent.succeeded acks without a credit_transactions row", async () => {
  const target = await buyer();
  for (const metadata of [
    miniappMetadata(target),
    miniappMetadata(target, { source: "", purchase_source: "miniapp_app" }),
    { ...miniappMetadata(target), type: "one_time", source: "" },
  ]) {
    for (let replay = 0; replay < 2; replay++)
      expect(
        await processStripeEvent(paymentIntentSucceeded(target, metadata)),
      ).toBe("ack");
  }
  expect(await creditRows(target.org)).toBe(0);
  expect(await balance(target.org)).toBe(0);
});

test("a legacy mini-app checkout.session.completed acks without a credit_transactions row", async () => {
  const target = await buyer();
  for (let replay = 0; replay < 2; replay++)
    expect(
      await processStripeEvent(
        checkoutSessionCompleted(target, miniappMetadata(target)),
      ),
    ).toBe("ack");
  expect(await creditRows(target.org)).toBe(0);
  expect(await balance(target.org)).toBe(0);
});

test("a retired purchase the old lane already credited is never credited twice", async () => {
  const target = await buyer("5");
  await pg().query(
    `INSERT INTO credit_transactions(organization_id,amount,type,description,stripe_payment_intent_id)
     VALUES ($1,'5','credit','App credit purchase',$2)`,
    [target.org, target.paymentIntentId],
  );
  const metadata = miniappMetadata(target);
  expect(
    await processStripeEvent(checkoutSessionCompleted(target, metadata)),
  ).toBe("ack");
  expect(
    await processStripeEvent(paymentIntentSucceeded(target, metadata)),
  ).toBe("ack");
  expect(await creditRows(target.org)).toBe(1);
  expect(await balance(target.org)).toBe(5);
});
