/**
 * Stripe does not guarantee event ordering. A `charge.refunded` or
 * `charge.dispute.funds_withdrawn` for a top-up can reach the queue before the
 * `checkout.session.completed` that grants the credits. The reversal must be
 * retried until the grant commits; acknowledging it leaves the refunded
 * customer with the credits. Real PGlite, real queue consumer and credits
 * service; the Stripe client is replaced by the sessions this test owns.
 */
import {
  afterAll,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import type Stripe from "stripe";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

/** Checkout sessions Stripe would list for a payment intent. */
const sessions = new Map<string, Record<string, unknown>>();
mock.module("@elizaos/cloud-shared/lib/stripe", () => ({
  isStripeConfigured: () => true,
  requireStripe: () => ({
    checkout: {
      sessions: {
        list: async ({ payment_intent }: { payment_intent: string }) => ({
          data: [sessions.get(payment_intent)].filter(Boolean),
          has_more: false,
        }),
      },
    },
    paymentIntents: {
      retrieve: async (id: string) => ({
        id,
        object: "payment_intent",
        status: "succeeded",
        metadata: {},
      }),
    },
  }),
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { creditPacks } = await import(
  "@elizaos/cloud-shared/db/schemas/credit-packs"
);
const { creditTransactions } = await import(
  "@elizaos/cloud-shared/db/schemas/credit-transactions"
);
const { stripeCheckoutOrders } = await import(
  "@elizaos/cloud-shared/db/schemas/stripe-checkout-orders"
);
const { organizationPaymentReversalHolds } = await import(
  "@elizaos/cloud-shared/db/schemas/organization-payment-reversal-holds"
);
const { referralCodes, referralSignups } = await import(
  "@elizaos/cloud-shared/db/schemas/referrals"
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
        creditPacks,
        creditTransactions,
        stripeCheckoutOrders,
        organizationPaymentReversalHolds,
        referralCodes,
        referralSignups,
        invoices,
      },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

interface PendingOrder {
  org: string;
  paymentIntentId: string;
  session: Record<string, unknown>;
}

/** A paid Checkout order whose completed event has not been consumed yet. */
async function pendingOrder(
  credits: number,
  cents: number,
): Promise<PendingOrder> {
  const org = randomUUID();
  const user = randomUUID();
  const order = randomUUID();
  const pack = randomUUID();
  const paymentIntentId = `pi_${org.replaceAll("-", "")}`;
  const sessionId = `cs_${org.replaceAll("-", "")}`;
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Buyer',$2,'0')",
    [org, `buyer-${org}`],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [user, org, `subject_${user}`],
  );
  await pg().query(
    `INSERT INTO credit_packs(id,name,credits,price_cents,stripe_price_id,stripe_product_id)
     VALUES ($1,'Pack',$2,$3,$4,$5)`,
    [pack, credits, cents, `price_${pack}`, `prod_${pack}`],
  );
  await pg().query(
    `INSERT INTO stripe_checkout_orders(
      id,organization_id,initiated_by_user_id,client_request_key,request_digest,purchase_type,
      credit_pack_id,credits_to_grant,charge_amount_cents,currency,stripe_customer_id,
      stripe_checkout_session_id,status
    ) VALUES ($1,$2,$3,$4,$5,'credit_pack',$6,$7,$8,'usd','cus_buyer',$9,'delivered')`,
    [
      order,
      org,
      user,
      `request-${org}`,
      "a".repeat(64),
      pack,
      credits,
      cents,
      sessionId,
    ],
  );
  const session = {
    id: sessionId,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    payment_intent: paymentIntentId,
    amount_total: cents,
    currency: "usd",
    customer: "cus_buyer",
    client_reference_id: order,
    metadata: { checkout_order_id: order },
  };
  sessions.set(paymentIntentId, session);
  return { org, paymentIntentId, session };
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
      event: { id: eventId, type, data: { object } } as unknown as Stripe.Event,
    },
  };
}

function refundEvent(
  chargeId: string,
  amountRefundedCents: number,
  paymentIntentId: string,
) {
  return delivery("charge.refunded", {
    id: chargeId,
    object: "charge",
    invoice: null,
    amount_refunded: amountRefundedCents,
    payment_intent: paymentIntentId,
  });
}

function disputeWithdrawn(
  disputeId: string,
  amountCents: number,
  paymentIntentId: string,
) {
  return delivery("charge.dispute.funds_withdrawn", {
    id: disputeId,
    object: "dispute",
    amount: amountCents,
    charge: { id: `ch_${disputeId}`, object: "charge", invoice: null },
    payment_intent: paymentIntentId,
  });
}

async function balance(org: string): Promise<number> {
  const rows = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [org],
  );
  return Number(rows.rows[0]?.credit_balance);
}

async function ledger(org: string): Promise<string[]> {
  const rows = await pg().query<{ type: string }>(
    "SELECT type FROM credit_transactions WHERE organization_id=$1 ORDER BY created_at, type",
    [org],
  );
  return rows.rows.map((row) => row.type);
}

test("a refund delivered before the checkout grant is retried, then claws the grant back", async () => {
  const order = await pendingOrder(10, 1000);
  const refund = refundEvent(`ch_${randomUUID()}`, 1000, order.paymentIntentId);

  expect(await processStripeEvent(refund)).toBe("retry");
  expect(await ledger(order.org)).toEqual([]);

  expect(
    await processStripeEvent(
      delivery("checkout.session.completed", order.session),
    ),
  ).toBe("ack");
  expect(await balance(order.org)).toBe(10);

  expect(await processStripeEvent(refund)).toBe("ack");
  expect(await balance(order.org)).toBe(0);
  expect(await ledger(order.org)).toEqual(["credit", "clawback"]);
});

test("a dispute delivered before the checkout grant is retried", async () => {
  const order = await pendingOrder(10, 1000);
  expect(
    await processStripeEvent(
      disputeWithdrawn(`dp_${randomUUID()}`, 1000, order.paymentIntentId),
    ),
  ).toBe("retry");
  expect(await ledger(order.org)).toEqual([]);
});

test("a refund for a legacy credit-pack session, which is quarantined and never grants, is acknowledged", async () => {
  const org = randomUUID();
  const paymentIntentId = `pi_${org.replaceAll("-", "")}`;
  sessions.set(paymentIntentId, {
    id: `cs_${org.replaceAll("-", "")}`,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    payment_intent: paymentIntentId,
    amount_total: 1000,
    currency: "usd",
    customer: "cus_buyer",
    metadata: { type: "credit_pack", organization_id: org, credits: "10" },
  });
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 1000, paymentIntentId),
    ),
  ).toBe("ack");
});

test("a refund for a payment that never grants credits is still acknowledged", async () => {
  const paymentIntentId = `pi_${randomUUID().replaceAll("-", "")}`;
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 500, paymentIntentId),
    ),
  ).toBe("ack");
});
