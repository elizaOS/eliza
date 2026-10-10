/**
 * Drives the real Stripe queue consumer and real credits service against a
 * PGlite database built from the Drizzle schema. Proves dispute reinstatement
 * restores the clawback's applied credit units (#31449), not provider dollars,
 * and that an underfunding reversal holds paid admission until repayment or
 * reinstatement clears it (#22930). Expanded synthetic charges keep every case
 * free of provider requests.
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
const { billingHoldService, BillingHoldActiveError } = await import(
  "@elizaos/cloud-shared/lib/services/billing-hold"
);
const { creditsService } = await import(
  "@elizaos/cloud-shared/lib/services/credits"
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

interface Purchase {
  org: string;
  paymentIntentId: string;
}

/** Seed an org that bought `credits` for `cents` and currently holds `balance`. */
async function purchase(params: {
  credits: string;
  cents: number | null;
  balance: string;
  metadata?: Record<string, string>;
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
    `INSERT INTO credit_transactions(organization_id,amount,type,description,stripe_payment_intent_id,metadata)
     VALUES ($1,$2,'credit','Credit pack purchase',$3,$4) RETURNING id`,
    [
      org,
      params.credits,
      paymentIntentId,
      JSON.stringify(params.metadata ?? {}),
    ],
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
  type:
    | "charge.dispute.funds_withdrawn"
    | "charge.dispute.funds_reinstated"
    | "charge.dispute.closed",
  disputeId: string,
  amountCents: number,
  paymentIntentId: string,
) {
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
        data: {
          object: {
            id: disputeId,
            object: "dispute",
            amount: amountCents,
            // Expanded one-time charge: no invoice, so no provider lookup.
            charge: { id: `ch_${disputeId}`, object: "charge", invoice: null },
            payment_intent: paymentIntentId,
            ...(type === "charge.dispute.closed" ? { status: "lost" } : {}),
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

test("a half dispute on a $15 fee-inclusive auto top-up claws back half of its 10 credits", async () => {
  const buyer = await purchase({
    credits: "10",
    cents: null,
    balance: "10",
    metadata: {
      type: "auto_top_up",
      auto_top_up_attempt_id: randomUUID(),
      base_amount: "10.00",
      total_charged: "15.00",
      platform_fee_amount: "2.00",
      affiliate_fee_amount: "3.00",
      fees_included: "true",
    },
  });
  expect(await disputeRoundTrip(buyer, `dp_${randomUUID()}`, 750)).toBe(5);
  expect(await balance(buyer.org)).toBe(10);
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 10],
    ["clawback", -5],
    ["refund", 5],
  ]);
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

function refundEvent(
  chargeId: string,
  amountRefundedCents: number,
  paymentIntentId: string,
) {
  const eventId = `evt_${randomUUID()}`;
  return {
    attempts: 1,
    body: {
      kind: "stripe.event" as const,
      eventId,
      eventType: "charge.refunded",
      receivedAt: Date.now(),
      event: {
        id: eventId,
        type: "charge.refunded",
        data: {
          object: {
            id: chargeId,
            object: "charge",
            invoice: null,
            amount_refunded: amountRefundedCents,
            payment_intent: paymentIntentId,
          },
        },
      } as unknown as Stripe.Event,
    },
  };
}

function topUpEvent(org: string, credits: number) {
  const eventId = `evt_${randomUUID()}`;
  const paymentIntentId = `pi_topup_${randomUUID().replaceAll("-", "")}`;
  return {
    attempts: 1,
    body: {
      kind: "stripe.event" as const,
      eventId,
      eventType: "payment_intent.succeeded",
      receivedAt: Date.now(),
      event: {
        id: eventId,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: paymentIntentId,
            object: "payment_intent",
            amount: credits * 100,
            amount_received: credits * 100,
            currency: "usd",
            invoice: null,
            metadata: {
              organization_id: org,
              credits: String(credits),
              type: "one_time",
            },
          },
        },
      } as unknown as Stripe.Event,
    },
  };
}

async function holdRows(org: string) {
  const rows = await pg().query<{
    reason: string;
    shortfall_usd: string;
    outstanding_usd: string;
    released_by: string | null;
  }>(
    "SELECT reason, shortfall_usd, outstanding_usd, released_by FROM organization_payment_reversal_holds WHERE organization_id=$1 ORDER BY created_at",
    [org],
  );
  return rows.rows.map((row) => ({
    reason: row.reason,
    shortfall: Number(row.shortfall_usd),
    outstanding: Number(row.outstanding_usd),
    releasedBy: row.released_by,
  }));
}

test("a fully recovered refund leaves no billing hold", async () => {
  const buyer = await purchase({ credits: "50", cents: 5000, balance: "50" });
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 5000, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await holdRows(buyer.org)).toEqual([]);
  expect(await billingHoldService.getState(buyer.org)).toEqual({
    status: "clear",
  });
});

test("a refund after consumption holds admission until a top-up repays the shortfall", async () => {
  const buyer = await purchase({ credits: "50", cents: 5000, balance: "20" });
  const chargeId = `ch_${randomUUID()}`;
  // Partial refund, then the cumulative full refund; each is replayed.
  for (const cents of [1000, 1000, 5000, 5000])
    expect(
      await processStripeEvent(
        refundEvent(chargeId, cents, buyer.paymentIntentId),
      ),
    ).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await holdRows(buyer.org)).toEqual([
    {
      reason: "reversal_shortfall",
      shortfall: 30,
      outstanding: 30,
      releasedBy: null,
    },
  ]);
  const held = await billingHoldService.getState(buyer.org);
  expect(held).toMatchObject({
    status: "held",
    outstandingUsd: "30.000000",
    payAction: { kind: "add_funds", amountUsd: "30.00" },
  });
  await expect(
    billingHoldService.assertNoHold(buyer.org),
  ).rejects.toBeInstanceOf(BillingHoldActiveError);

  // A partial top-up repays part of the debt and keeps the hold.
  expect(await processStripeEvent(topUpEvent(buyer.org, 10))).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await holdRows(buyer.org)).toEqual([
    {
      reason: "reversal_shortfall",
      shortfall: 30,
      outstanding: 20,
      releasedBy: null,
    },
  ]);

  // Credits granted outside the card path are applied by the pay action.
  await creditsService.addCredits({
    organizationId: buyer.org,
    amount: "25",
    description: "Operator grant",
  });
  const settled = await billingHoldService.settleOutstandingShortfalls(
    buyer.org,
  );
  expect(settled).toMatchObject({
    appliedUsd: "20.000000",
    outstandingUsd: "0.000000",
  });
  expect(await balance(buyer.org)).toBe(5);
  expect(await holdRows(buyer.org)).toEqual([
    {
      reason: "reversal_shortfall",
      shortfall: 30,
      outstanding: 0,
      releasedBy: "system:repayment",
    },
  ]);
  await billingHoldService.assertNoHold(buyer.org);
  // Settling again is a no-op.
  expect(
    await billingHoldService.settleOutstandingShortfalls(buyer.org),
  ).toMatchObject({
    appliedUsd: "0.000000",
  });
  expect(await balance(buyer.org)).toBe(5);
});

test("a lost dispute keeps the shortfall hold; it clears only by repayment", async () => {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "100" });
  const disputeId = `dp_${randomUUID()}`;
  for (const type of [
    "charge.dispute.funds_withdrawn",
    "charge.dispute.closed",
  ] as const)
    expect(
      await processStripeEvent(
        disputeEvent(type, disputeId, 1000, buyer.paymentIntentId),
      ),
    ).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await holdRows(buyer.org)).toEqual([
    {
      reason: "reversal_shortfall",
      shortfall: 400,
      outstanding: 400,
      releasedBy: null,
    },
  ]);
});

test("a won dispute clears its hold and returns any repayment toward it", async () => {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "50" });
  const disputeId = `dp_${randomUUID()}`;
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        disputeId,
        1000,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  // The organization repays $100 of the $450 shortfall before the dispute is won.
  expect(await processStripeEvent(topUpEvent(buyer.org, 100))).toBe("ack");
  expect(await holdRows(buyer.org)).toEqual([
    {
      reason: "reversal_shortfall",
      shortfall: 450,
      outstanding: 350,
      releasedBy: null,
    },
  ]);
  for (let delivery = 0; delivery < 2; delivery++)
    expect(
      await processStripeEvent(
        disputeEvent(
          "charge.dispute.funds_reinstated",
          disputeId,
          1000,
          buyer.paymentIntentId,
        ),
      ),
    ).toBe("ack");
  // 50 applied clawback restored plus the 100 repayment returned, exactly once.
  expect(await balance(buyer.org)).toBe(150);
  expect(await holdRows(buyer.org)).toEqual([
    {
      reason: "reversal_shortfall",
      shortfall: 450,
      outstanding: 350,
      releasedBy: "system:dispute_reinstated",
    },
  ]);
  expect(await billingHoldService.getState(buyer.org)).toEqual({
    status: "clear",
  });
});
