/**
 * Drives the real Stripe queue consumer and real credits service against a
 * PGlite database built from the Drizzle schema. Proves dispute reinstatement
 * restores the clawback's applied credit units (#31449), not provider dollars.
 * Expanded synthetic charges keep every case free of provider requests.
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
  await import("@/db/client");
const { organizations } = await import("@/db/schemas/organizations");
const { users } = await import("@/db/schemas/users");
const { creditPacks } = await import("@/db/schemas/credit-packs");
const { creditTransactions } = await import("@/db/schemas/credit-transactions");
const { stripeCheckoutOrders } = await import(
  "@/db/schemas/stripe-checkout-orders"
);
const { processStripeEvent } = await import("../src/queue/stripe-event");

const pg = () => getPgliteClientForTests();

beforeAll(async () => {
  // Touch the lazy client so the PGlite instance exists.
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
      },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

interface Purchase {
  org: string;
  paymentIntentId: string;
}

/** Seed an org that bought `credits` for `cents` and currently holds `balance`. */
async function purchase(params: {
  credits: string;
  cents: number | null;
  balance: string;
}): Promise<Purchase> {
  const org = randomUUID();
  const user = randomUUID();
  const paymentIntentId = `pi_${org.replaceAll("-", "")}`;
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Buyer',$2,$3)",
    [org, `buyer-${org}`, params.balance],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [user, org, `subject_${user}`],
  );
  const grant = await pg().query<{ id: string }>(
    `INSERT INTO credit_transactions(organization_id,amount,type,description,stripe_payment_intent_id)
     VALUES ($1,$2,'credit','Credit pack purchase',$3) RETURNING id`,
    [org, params.credits, paymentIntentId],
  );
  if (params.cents !== null) {
    const pack = randomUUID();
    await pg().query(
      `INSERT INTO credit_packs(id,name,credits,price_cents,stripe_price_id,stripe_product_id)
       VALUES ($1,'Pack',$2,$3,$4,$5)`,
      [pack, params.credits, params.cents, `price_${pack}`, `prod_${pack}`],
    );
    await pg().query(
      `INSERT INTO stripe_checkout_orders(
        organization_id,initiated_by_user_id,client_request_key,request_digest,purchase_type,
        credit_pack_id,credits_to_grant,charge_amount_cents,currency,stripe_customer_id,
        stripe_checkout_session_id,stripe_payment_intent_id,credit_transaction_id,status,settled_at
      ) VALUES ($1,$2,$3,$4,'credit_pack',$5,$6,$7,'usd','cus_buyer',$8,$9,$10,'settled',now())`,
      [
        org,
        user,
        `request-${org}`,
        "a".repeat(64),
        pack,
        params.credits,
        params.cents,
        `cs_${org}`,
        paymentIntentId,
        grant.rows[0]?.id,
      ],
    );
  }
  return { org, paymentIntentId };
}

function disputeEvent(
  type: "charge.dispute.funds_withdrawn" | "charge.dispute.funds_reinstated",
  disputeId: string,
  amountCents: number,
  paymentIntentId: string,
) {
  return {
    attempts: 1,
    body: {
      eventId: `evt_${randomUUID()}`,
      event: {
        id: `evt_${randomUUID()}`,
        type,
        data: {
          object: {
            id: disputeId,
            object: "dispute",
            amount: amountCents,
            // Expanded one-time charge: no invoice, so no provider lookup.
            charge: { id: `ch_${disputeId}`, object: "charge", invoice: null },
            payment_intent: paymentIntentId,
          },
        },
      } as unknown as Stripe.Event,
    },
  };
}

async function balance(org: string): Promise<number> {
  const rows = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [org],
  );
  return Number(rows.rows[0]?.credit_balance);
}

async function ledger(org: string): Promise<Array<[string, number]>> {
  const rows = await pg().query<{ type: string; amount: string }>(
    "SELECT type, amount FROM credit_transactions WHERE organization_id=$1 ORDER BY created_at, type",
    [org],
  );
  return rows.rows.map((row) => [row.type, Number(row.amount)]);
}

async function disputeRoundTrip(
  buyer: Purchase,
  disputeId: string,
  amountCents: number,
) {
  // Stripe does not order events: an early reinstatement must retry.
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_reinstated",
        disputeId,
        amountCents,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("retry");
  for (let delivery = 0; delivery < 2; delivery++)
    expect(
      await processStripeEvent(
        disputeEvent(
          "charge.dispute.funds_withdrawn",
          disputeId,
          amountCents,
          buyer.paymentIntentId,
        ),
      ),
    ).toBe("ack");
  const afterWithdrawal = await balance(buyer.org);
  for (let delivery = 0; delivery < 2; delivery++)
    expect(
      await processStripeEvent(
        disputeEvent(
          "charge.dispute.funds_reinstated",
          disputeId,
          amountCents,
          buyer.paymentIntentId,
        ),
      ),
    ).toBe("ack");
  return afterWithdrawal;
}

test("a won dispute on a $10 / 500-credit pack restores all 500 credits exactly once", async () => {
  const bystander = await purchase({
    credits: "77",
    cents: 7700,
    balance: "77",
  });
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "500" });
  expect(await disputeRoundTrip(buyer, `dp_${randomUUID()}`, 1000)).toBe(0);
  expect(await balance(buyer.org)).toBe(500);
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 500],
    ["clawback", -500],
    ["refund", 500],
  ]);
  expect(await balance(bystander.org)).toBe(77);
});

test("a partially consumed pack restores only the applied clawback, never the shortfall", async () => {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "50" });
  expect(await disputeRoundTrip(buyer, `dp_${randomUUID()}`, 1000)).toBe(0);
  expect(await balance(buyer.org)).toBe(50);
  const shortfall = await pg().query<{ unrecovered: string }>(
    "SELECT metadata->>'unrecovered_clawback_usd' AS unrecovered FROM credit_transactions WHERE organization_id=$1 AND type='clawback'",
    [buyer.org],
  );
  expect(Number(shortfall.rows[0]?.unrecovered)).toBe(450);
});

test("a partial $3 dispute on a $10 / 500-credit pack restores 150 credits", async () => {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "500" });
  expect(await disputeRoundTrip(buyer, `dp_${randomUUID()}`, 300)).toBe(350);
  expect(await balance(buyer.org)).toBe(500);
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 500],
    ["clawback", -150],
    ["refund", 150],
  ]);
});

test("a legacy 1:1 top-up without a checkout order restores dollars as credits", async () => {
  const buyer = await purchase({ credits: "10", cents: null, balance: "10" });
  expect(await disputeRoundTrip(buyer, `dp_${randomUUID()}`, 1000)).toBe(0);
  expect(await balance(buyer.org)).toBe(10);
});

test("a dispute with nothing left to claw back reinstates nothing", async () => {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "0" });
  expect(await disputeRoundTrip(buyer, `dp_${randomUUID()}`, 1000)).toBe(0);
  expect(await balance(buyer.org)).toBe(0);
  expect((await ledger(buyer.org)).map(([type]) => type)).toEqual([
    "credit",
    "clawback",
  ]);
});
