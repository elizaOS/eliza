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
const {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
} = await import("@elizaos/cloud-shared/db/schemas/redeemable-earnings");
const { redeemableEarningsService } = await import(
  "@elizaos/cloud-shared/lib/services/redeemable-earnings"
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
        earningsSourceEnum,
        ledgerEntryTypeEnum,
        redeemableEarnings,
        redeemableEarningsLedger,
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
  const buyer = await affiliateTopUp();
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

test("a partial refund then a dispute for the remainder claws back the whole grant", async () => {
  const buyer = await purchase({
    credits: "500",
    cents: 10000,
    balance: "500",
  });
  const chargeId = `ch_${randomUUID()}`;
  expect(
    await processStripeEvent(
      refundEvent(chargeId, 2000, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await balance(buyer.org)).toBe(400);
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        `dp_${randomUUID()}`,
        8000,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 500],
    ["clawback", -100],
    ["clawback", -400],
  ]);
  expect(await holdRows(buyer.org)).toEqual([]);
});

test("a dispute then a refund of the undisputed remainder claws back the whole grant", async () => {
  const buyer = await purchase({
    credits: "500",
    cents: 10000,
    balance: "500",
  });
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        `dp_${randomUUID()}`,
        8000,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(await balance(buyer.org)).toBe(100);
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 2000, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 500],
    ["clawback", -400],
    ["clawback", -100],
  ]);
});

test("a full refund after a lost full dispute does not claw back twice", async () => {
  const buyer = await purchase({
    credits: "500",
    cents: 10000,
    balance: "500",
  });
  const disputeId = `dp_${randomUUID()}`;
  for (const type of [
    "charge.dispute.funds_withdrawn",
    "charge.dispute.closed",
  ] as const) {
    expect(
      await processStripeEvent(
        disputeEvent(type, disputeId, 10000, buyer.paymentIntentId),
      ),
    ).toBe("ack");
  }
  expect(await balance(buyer.org)).toBe(0);
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 10000, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 500],
    ["clawback", -500],
  ]);
  expect(await holdRows(buyer.org)).toEqual([]);
});

test("a full refund after a lost dispute that left a shortfall does not book the debt twice", async () => {
  // 500 credits bought for 10000 cents; the organization has used 400 of them.
  const buyer = await purchase({
    credits: "500",
    cents: 10000,
    balance: "100",
  });
  const disputeId = `dp_${randomUUID()}`;
  for (const type of [
    "charge.dispute.funds_withdrawn",
    "charge.dispute.closed",
  ] as const) {
    expect(
      await processStripeEvent(
        disputeEvent(type, disputeId, 10000, buyer.paymentIntentId),
      ),
    ).toBe("ack");
  }
  const refund = refundEvent(
    `ch_${randomUUID()}`,
    10000,
    buyer.paymentIntentId,
  );
  expect(await processStripeEvent(refund)).toBe("ack");
  expect(await processStripeEvent(refund)).toBe("ack");

  expect(await balance(buyer.org)).toBe(0);
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 500],
    ["clawback", -100],
  ]);
  expect(await holdRows(buyer.org)).toEqual([
    {
      reason: "reversal_shortfall",
      shortfall: 400,
      outstanding: 400,
      releasedBy: null,
    },
  ]);
});

test("cumulative partial refunds on a low balance book each unrecovered credit once", async () => {
  const buyer = await purchase({ credits: "500", cents: 10000, balance: "50" });
  const chargeId = `ch_${randomUUID()}`;
  // 2000 cents refunded (100 credits), then 5000 cumulative (250 credits).
  for (const cents of [2000, 5000])
    expect(
      await processStripeEvent(
        refundEvent(chargeId, cents, buyer.paymentIntentId),
      ),
    ).toBe("ack");

  expect(await balance(buyer.org)).toBe(0);
  const holds = await holdRows(buyer.org);
  const applied = -(await ledger(buyer.org))
    .filter(([type]) => type === "clawback")
    .reduce((sum, [, amount]) => sum + amount, 0);
  const unrecovered = holds.reduce((sum, hold) => sum + hold.shortfall, 0);
  // Applied plus unrecovered equals the 250 credits Stripe reversed.
  expect(applied).toBe(50);
  expect(unrecovered).toBe(200);
});

/** A $15 auto top-up (10 credits) whose $3 affiliate fee was paid out as earnings. */
async function affiliateTopUp(
  deferFee = false,
): Promise<Purchase & { affiliate: string }> {
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
  const affiliate = randomUUID();
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [affiliate, buyer.org, `subject_${affiliate}`],
  );
  if (deferFee) return { ...buyer, affiliate };
  // The same credit the payment_intent.succeeded handler books.
  const earned = await redeemableEarningsService.addEarnings({
    userId: affiliate,
    amount: 3,
    source: "affiliate",
    sourceId: `affiliate_auto_topup:${buyer.paymentIntentId}:${randomUUID()}`,
    dedupeBySourceId: true,
    description: "Auto top-up affiliate fee",
    metadata: { payment_intent_id: buyer.paymentIntentId },
  });
  expect(earned.success).toBe(true);
  return { ...buyer, affiliate };
}

/** What the affiliate payout sums: affiliate earning + adjustment ledger rows. */
async function affiliatePayable(userId: string): Promise<number> {
  const rows = await pg().query<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total FROM redeemable_earnings_ledger
     WHERE user_id=$1 AND earnings_source='affiliate' AND entry_type IN ('earning','adjustment')`,
    [userId],
  );
  return Number(rows.rows[0]?.total);
}

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

test("refunds of an auto top-up take back the same share of its affiliate fee", async () => {
  const buyer = await affiliateTopUp();
  const charge = `ch_${randomUUID()}`;
  for (let delivery = 0; delivery < 2; delivery++)
    expect(
      await processStripeEvent(refundEvent(charge, 750, buyer.paymentIntentId)),
    ).toBe("ack");
  expect(await affiliatePayable(buyer.affiliate)).toBe(1.5);

  expect(
    await processStripeEvent(refundEvent(charge, 1500, buyer.paymentIntentId)),
  ).toBe("ack");
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);
});

test("a dispute takes back the affiliate fee and a won dispute returns it", async () => {
  const buyer = await affiliateTopUp();
  const disputeId = `dp_${randomUUID()}`;
  await disputeRoundTrip(buyer, disputeId, 1500);
  expect(await affiliatePayable(buyer.affiliate)).toBe(3);

  const lost = await affiliateTopUp();
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        `dp_${randomUUID()}`,
        1500,
        lost.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(await affiliatePayable(lost.affiliate)).toBe(0);
});

test("a full dispute and a full refund of one charge reverse the affiliate fee once, in either order", async () => {
  const disputeFirst = await affiliateTopUp();
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        `dp_${randomUUID()}`,
        1500,
        disputeFirst.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 1500, disputeFirst.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await affiliatePayable(disputeFirst.affiliate)).toBe(0);

  const refundFirst = await affiliateTopUp();
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 1500, refundFirst.paymentIntentId),
    ),
  ).toBe("ack");
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        `dp_${randomUUID()}`,
        1500,
        refundFirst.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(await affiliatePayable(refundFirst.affiliate)).toBe(0);
});

test("a won dispute and a full refund of one charge leave the affiliate fee reversed once", async () => {
  const wonThenRefunded = await affiliateTopUp();
  await disputeRoundTrip(wonThenRefunded, `dp_${randomUUID()}`, 1500);
  expect(await affiliatePayable(wonThenRefunded.affiliate)).toBe(3);
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 1500, wonThenRefunded.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await affiliatePayable(wonThenRefunded.affiliate)).toBe(0);

  // Half refunded, the other half disputed and won: only the refund stays reversed.
  const refundedThenWon = await affiliateTopUp();
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 750, refundedThenWon.paymentIntentId),
    ),
  ).toBe("ack");
  await disputeRoundTrip(refundedThenWon, `dp_${randomUUID()}`, 750);
  expect(await affiliatePayable(refundedThenWon.affiliate)).toBe(1.5);
});

test("a refund that lands between a dispute and its reinstatement stays reversed", async () => {
  const buyer = await affiliateTopUp();
  const disputeId = `dp_${randomUUID()}`;
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        disputeId,
        1500,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  // The dispute already took the whole fee and grant, so the refund adds nothing yet.
  expect(
    await processStripeEvent(
      refundEvent(`ch_${disputeId}`, 1500, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);
  expect(await balance(buyer.org)).toBe(0);

  // Stripe returns the disputed funds, but the full refund still stands.
  const reinstated = disputeEvent(
    "charge.dispute.funds_reinstated",
    disputeId,
    1500,
    buyer.paymentIntentId,
  );
  (
    reinstated.body.event.data.object as unknown as {
      charge: Record<string, unknown>;
    }
  ).charge.amount_refunded = 1500;
  for (let delivery = 0; delivery < 2; delivery++)
    expect(await processStripeEvent(reinstated)).toBe("ack");

  expect(await affiliatePayable(buyer.affiliate)).toBe(0);
  expect(await balance(buyer.org)).toBe(0);
});

async function affiliateAvailable(userId: string): Promise<number> {
  const rows = await pg().query<{ available: string }>(
    "SELECT available_balance::text AS available FROM redeemable_earnings WHERE user_id=$1",
    [userId],
  );
  return Number(rows.rows[0]?.available);
}

test("a won dispute does not return an affiliate fee the affiliate already spent", async () => {
  const buyer = await affiliateTopUp();
  // The affiliate is paid the $3 fee out first, as debitAffiliatePayout does.
  const paidOut = await redeemableEarningsService.reduceEarnings({
    userId: buyer.affiliate,
    amount: 3,
    source: "affiliate",
    sourceId: `payout:${randomUUID()}`,
    description: "Affiliate payout",
    requireSufficientBalance: true,
    dedupeBySourceId: true,
    countAsRedeemed: true,
  });
  expect(paidOut.success).toBe(true);
  expect(await affiliateAvailable(buyer.affiliate)).toBe(0);
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);

  // The withdrawal can take nothing from the paid-out balance, so it books the
  // fee as ledger debt, and winning the dispute clears that debt without
  // adding the fee to the balance a second time.
  await disputeRoundTrip(buyer, `dp_${randomUUID()}`, 1500);
  expect(await affiliateAvailable(buyer.affiliate)).toBe(0);
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);

  // A later full refund books the paid-out fee as debt once.
  const charge = `ch_${randomUUID()}`;
  for (let delivery = 0; delivery < 2; delivery++)
    expect(
      await processStripeEvent(
        refundEvent(charge, 1500, buyer.paymentIntentId),
      ),
    ).toBe("ack");
  expect(await affiliateAvailable(buyer.affiliate)).toBe(0);
  expect(await affiliatePayable(buyer.affiliate)).toBe(-3);
});

test("a refund waits for the pending affiliate earning before acknowledgement", async () => {
  const buyer = await affiliateTopUp(true);
  const event = refundEvent(`ch_${randomUUID()}`, 1500, buyer.paymentIntentId);
  expect(await processStripeEvent(event)).toBe("retry");
  const earned = await redeemableEarningsService.addEarnings({
    userId: buyer.affiliate,
    amount: 3,
    source: "affiliate",
    sourceId: `affiliate_auto_topup:${buyer.paymentIntentId}:${randomUUID()}`,
    dedupeBySourceId: true,
    description: "Delayed auto top-up affiliate fee",
    metadata: { payment_intent_id: buyer.paymentIntentId },
  });
  expect(earned.success).toBe(true);
  expect(await processStripeEvent(event)).toBe("ack");
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);
});

/** A referred buyer's $10 / 500-credit Checkout pack that paid $4 + $1 revenue splits. */
async function referredCheckout(): Promise<
  Purchase & { appOwner: string; creator: string }
> {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "500" });
  const appOwner = randomUUID();
  const creator = randomUUID();
  for (const [userId, source, amount] of [
    [appOwner, "app_owner_revenue_share", 4],
    [creator, "creator_revenue_share", 1],
  ] as const) {
    await pg().query(
      "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
      [userId, buyer.org, `subject_${userId}`],
    );
    // The same credit handleCheckoutSessionCompleted books for each split.
    const earned = await redeemableEarningsService.addEarnings({
      userId,
      amount,
      source,
      sourceId: `revenue_split:${buyer.paymentIntentId}:${userId}`,
      dedupeBySourceId: true,
      description: "Revenue share",
      metadata: { payment_intent_id: buyer.paymentIntentId },
    });
    expect(earned.success).toBe(true);
  }
  return { ...buyer, appOwner, creator };
}

async function earnedLedger(userId: string): Promise<number> {
  const rows = await pg().query<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total FROM redeemable_earnings_ledger
     WHERE user_id=$1 AND entry_type IN ('earning','adjustment')`,
    [userId],
  );
  return Number(rows.rows[0]?.total);
}

test("refunds of a referred Checkout purchase take back the same share of its revenue splits", async () => {
  const buyer = await referredCheckout();
  const charge = `ch_${randomUUID()}`;
  for (let delivery = 0; delivery < 2; delivery++)
    expect(
      await processStripeEvent(refundEvent(charge, 500, buyer.paymentIntentId)),
    ).toBe("ack");
  expect(await earnedLedger(buyer.appOwner)).toBe(2);
  expect(await earnedLedger(buyer.creator)).toBe(0.5);

  expect(
    await processStripeEvent(refundEvent(charge, 1000, buyer.paymentIntentId)),
  ).toBe("ack");
  expect(await earnedLedger(buyer.appOwner)).toBe(0);
  expect(await earnedLedger(buyer.creator)).toBe(0);
});

test("a dispute takes back the revenue splits and a won dispute returns them", async () => {
  const won = await referredCheckout();
  await disputeRoundTrip(won, `dp_${randomUUID()}`, 1000);
  expect(await earnedLedger(won.appOwner)).toBe(4);
  expect(await earnedLedger(won.creator)).toBe(1);

  const lost = await referredCheckout();
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        `dp_${randomUUID()}`,
        1000,
        lost.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(await earnedLedger(lost.appOwner)).toBe(0);
  expect(await earnedLedger(lost.creator)).toBe(0);
});
