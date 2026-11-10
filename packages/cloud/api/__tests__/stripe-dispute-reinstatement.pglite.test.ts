/**
 * Drives the real Stripe queue consumer and real credits service against a
 * PGlite database built from the Drizzle schema. Proves dispute reinstatement
 * restores the clawback's applied credit units (#31449), not provider dollars,
 * and that an underfunding reversal holds paid admission until repayment or
 * reinstatement clears it (#22930). Expanded synthetic charges keep every case
 * free of provider requests.
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
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import { stripeReversalTestDatabase } from "./fixtures/stripe-reversal-database";

const testDatabase = await stripeReversalTestDatabase("reinstatement");
setDefaultTimeout(60_000);

const { closeDatabaseConnectionsForTests, dbWrite } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { sqlRows } = await import("@elizaos/cloud-shared/db/execute-helpers");
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
const { invoices } = await import("@elizaos/cloud-shared/db/schemas/invoices");
const { organizationPaymentReversalHolds } = await import(
  "@elizaos/cloud-shared/db/schemas/organization-payment-reversal-holds"
);
const {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
} = await import("@elizaos/cloud-shared/db/schemas/redeemable-earnings");
const { referralCodes, referralSignups } = await import(
  "@elizaos/cloud-shared/db/schemas/referrals"
);
const { redeemableEarningsService } = await import(
  "@elizaos/cloud-shared/lib/services/redeemable-earnings"
);
const { billingHoldService, BillingHoldActiveError } = await import(
  "@elizaos/cloud-shared/lib/services/billing-hold"
);
const { creditsService, InsufficientCreditsError } = await import(
  "@elizaos/cloud-shared/lib/services/credits"
);
const { reserveFlatUsageCredits } = await import(
  "@elizaos/cloud-shared/lib/services/ai-billing"
);
async function paidFlatReservation(org: string, amount: number) {
  const owner = await testDatabase.query<{ id: string }>(
    "SELECT id FROM users WHERE organization_id=$1 AND role='owner' LIMIT 1",
    [org],
  );
  return reserveFlatUsageCredits(
    {
      organizationId: org,
      userId: owner.rows[0]!.id,
      model: "local-flat-fixture",
      provider: "local",
      requestId: randomUUID(),
      affiliateAttribution: null,
    },
    { totalCost: amount, baseTotalCost: amount, platformMarkup: 0 },
    { subscriptionFunded: false },
  );
}
const { processStripeEvent } = await import("../src/queue/stripe-event");

const pg = () => testDatabase;

function pauseNextReinstatement() {
  const entered = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const record = creditsService.recordDisputeReinstatement.bind(creditsService);
  const paused = spyOn(
    creditsService,
    "recordDisputeReinstatement",
  ).mockImplementationOnce(async (params) => {
    const result = await record(params);
    const rows =
      testDatabase.native && params.db
        ? await sqlRows<{ pid: number }>(
            params.db,
            sql`SELECT pg_backend_pid() AS pid`,
          )
        : [];
    entered.resolve(rows[0]?.pid ?? 0);
    await release.promise;
    return result;
  });
  return {
    entered: entered.promise,
    release: release.resolve,
    restore: () => paused.mockRestore(),
  };
}

async function blockedPaidReservation(org: string, ownerPid: number) {
  let settled = false;
  const outcome = paidFlatReservation(org, 5).then(
    (reservation) => {
      settled = true;
      return { kind: "reserved" as const, reservation };
    },
    (error: unknown) => {
      settled = true;
      return { kind: "rejected" as const, error };
    },
  );
  if (testDatabase.native) await testDatabase.waitForBlockedMutation(ownerPid);
  else await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settled).toBe(false);
  return { outcome };
}

beforeAll(async () => {
  // Touch the lazy client so the PGlite instance exists.
  await dbWrite.execute("SELECT 1");
  await testDatabase.verifyProductionConnection(dbWrite);
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
        invoices,
        organizationPaymentReversalHolds,
        earningsSourceEnum,
        ledgerEntryTypeEnum,
        redeemableEarnings,
        redeemableEarningsLedger,
        referralCodes,
        referralSignups,
      },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
  await testDatabase.close();
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
  expect(await ledger(buyer.org)).toEqual([
    ["credit", 500],
    ["clawback", 0],
    ["refund", 0],
  ]);
});

test("a refund after a won zero-balance dispute creates its own shortfall", async () => {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "0" });
  const disputeId = `dp_${randomUUID()}`;
  await disputeRoundTrip(buyer, disputeId, 1000);
  expect(await billingHoldService.getState(buyer.org)).toEqual({
    status: "clear",
  });

  const refund = refundEvent(`ch_${disputeId}`, 1000, buyer.paymentIntentId);
  expect(await processStripeEvent(refund)).toBe("ack");
  expect(await processStripeEvent(refund)).toBe("ack");

  expect(await balance(buyer.org)).toBe(0);
  expect(await billingHoldService.getState(buyer.org)).toMatchObject({
    status: "held",
    outstandingUsd: "500.000000",
  });
  expect(
    (await holdRows(buyer.org)).filter((row) => row.releasedBy === null),
  ).toMatchObject([{ shortfall: 500, outstanding: 500 }]);
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
    ["clawback", 0],
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
    ["clawback", 0],
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
            customer: `cus_fixture_${org.replaceAll("-", "")}`,
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

test("a partially applied refund recovers the rest after the overlapping dispute is won", async () => {
  const buyer = await affiliateTopUp();
  const neighbor = await purchase({
    credits: "17",
    cents: 1700,
    balance: "17",
  });
  const disputeId = `dp_${randomUUID()}`;
  const withdrawal = disputeEvent(
    "charge.dispute.funds_withdrawn",
    disputeId,
    750,
    buyer.paymentIntentId,
  );
  expect(await processStripeEvent(withdrawal)).toBe("ack");

  const refund = refundEvent(`ch_${disputeId}`, 1500, buyer.paymentIntentId);
  expect(await processStripeEvent(refund)).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);

  const reinstated = disputeEvent(
    "charge.dispute.funds_reinstated",
    disputeId,
    750,
    buyer.paymentIntentId,
  );
  (
    reinstated.body.event.data.object as unknown as {
      charge: Record<string, unknown>;
    }
  ).charge.amount_refunded = 1500;
  // The failed repair must roll back the credit receipt and hold mutations.
  const repairKey = `stripe:refund:ch_${disputeId}:1500:reinstatement:${disputeId}`;
  await pg().exec(`
    CREATE FUNCTION fail_test_credit_reversal_repair() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.stripe_payment_intent_id = '${repairKey}' THEN
        RAISE EXCEPTION 'test interruption before credit reversal repair';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER fail_test_credit_reversal_repair BEFORE INSERT ON credit_transactions
    FOR EACH ROW EXECUTE FUNCTION fail_test_credit_reversal_repair();
  `);
  try {
    const paused = pauseNextReinstatement();
    const recovery = processStripeEvent(reinstated);
    const ownerPid = await paused.entered;
    let paid: Awaited<ReturnType<typeof blockedPaidReservation>> | undefined;
    try {
      paid = await blockedPaidReservation(buyer.org, ownerPid);
    } finally {
      paused.release();
      await recovery;
      paused.restore();
    }
    expect(await recovery).toBe("retry");
    const outcome = await paid!.outcome;
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected")
      expect(outcome.error).toBeInstanceOf(InsufficientCreditsError);
    testDatabase.record({
      event: "rollback-rejects-paid-reservation",
      ownerPid,
      recovery: "retry",
      outcome: outcome.kind,
    });
    expect(await balance(buyer.org)).toBe(0);
    expect(await affiliatePayable(buyer.affiliate)).toBe(0);
    expect(
      await creditsService.getTransactionByStripePaymentIntent(
        `stripe:dispute:${disputeId}:reinstated`,
      ),
    ).toBeUndefined();
    await expect(paidFlatReservation(buyer.org, 5)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  } finally {
    await pg().exec(`
      DROP TRIGGER fail_test_credit_reversal_repair ON credit_transactions;
      DROP FUNCTION fail_test_credit_reversal_repair();
    `);
  }
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await processStripeEvent(refund)).toBe("ack");

  expect(await balance(buyer.org)).toBe(0);
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);
  expect(await balance(neighbor.org)).toBe(17);
  expect(await holdRows(neighbor.org)).toEqual([]);
  expect(await ledger(neighbor.org)).toEqual([["credit", 17]]);
});

test("a failed reinstatement rolls back hold release and repayment return together", async () => {
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
  expect(await processStripeEvent(topUpEvent(buyer.org, 100))).toBe("ack");
  expect(await billingHoldService.getState(buyer.org)).toMatchObject({
    status: "held",
    outstandingUsd: "350.000000",
  });
  const reinstated = disputeEvent(
    "charge.dispute.funds_reinstated",
    disputeId,
    1000,
    buyer.paymentIntentId,
  );
  (
    reinstated.body.event.data.object as unknown as {
      charge: Record<string, unknown>;
    }
  ).charge.amount_refunded = 1000;
  const repairKey = `stripe:refund:ch_${disputeId}:1000:reinstatement:${disputeId}`;
  await pg().exec(`CREATE FUNCTION fail_repaid_reinstatement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.stripe_payment_intent_id = '${repairKey}' THEN
      RAISE EXCEPTION 'test rollback after repayment return'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_repaid_reinstatement BEFORE INSERT ON credit_transactions
    FOR EACH ROW EXECUTE FUNCTION fail_repaid_reinstatement();`);
  try {
    expect(await processStripeEvent(reinstated)).toBe("retry");
    expect(await balance(buyer.org)).toBe(0);
    expect(await billingHoldService.getState(buyer.org)).toMatchObject({
      status: "held",
      outstandingUsd: "350.000000",
    });
    expect(
      await creditsService.getTransactionByStripePaymentIntent(
        `stripe:dispute:${disputeId}:reinstated`,
      ),
    ).toBeUndefined();
    expect(
      await creditsService.getTransactionByStripePaymentIntent(
        `stripe:dispute:${disputeId}:repayment-returned`,
      ),
    ).toBeUndefined();
    await expect(paidFlatReservation(buyer.org, 1)).rejects.toBeInstanceOf(
      BillingHoldActiveError,
    );
  } finally {
    await pg().exec(
      "DROP TRIGGER fail_repaid_reinstatement ON credit_transactions; DROP FUNCTION fail_repaid_reinstatement();",
    );
  }
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await billingHoldService.getState(buyer.org)).toMatchObject({
    status: "held",
    outstandingUsd: "350.000000",
  });
  expect(
    (await ledger(buyer.org)).filter(([type]) => type === "refund"),
  ).toEqual([
    ["refund", 100],
    ["refund", 50],
  ]);
});

test("a concurrent paid reservation cannot observe an uncommitted reinstatement receipt", async () => {
  const buyer = await affiliateTopUp();
  const disputeId = `dp_${randomUUID()}`;
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        disputeId,
        750,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(
    await processStripeEvent(
      refundEvent(`ch_${disputeId}`, 1500, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  const reinstated = disputeEvent(
    "charge.dispute.funds_reinstated",
    disputeId,
    750,
    buyer.paymentIntentId,
  );
  (
    reinstated.body.event.data.object as unknown as {
      charge: Record<string, unknown>;
    }
  ).charge.amount_refunded = 1500;
  const paused = pauseNextReinstatement();
  const recovery = processStripeEvent(reinstated);
  const ownerPid = await paused.entered;
  let paid: Awaited<ReturnType<typeof blockedPaidReservation>> | undefined;
  try {
    paid = await blockedPaidReservation(buyer.org, ownerPid);
  } finally {
    paused.release();
    await recovery;
    paused.restore();
  }
  expect(await recovery).toBe("ack");
  const outcome = await paid!.outcome;
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind === "rejected")
    expect(outcome.error).toBeInstanceOf(InsufficientCreditsError);
  expect(await balance(buyer.org)).toBe(0);
  testDatabase.record({
    event: "commit-rejects-paid-reservation",
    ownerPid,
    recovery: "ack",
    outcome: outcome.kind,
  });
});

test("a committed refund during preparation aborts reinstatement before paid credit becomes visible", async () => {
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
  const refund = refundEvent(`ch_${disputeId}`, 1500, buyer.paymentIntentId);
  const reinstated = disputeEvent(
    "charge.dispute.funds_reinstated",
    disputeId,
    1500,
    buyer.paymentIntentId,
  );
  const original = redeemableEarningsService.reinstateRevenueSplits.bind(
    redeemableEarningsService,
  );
  const duringPreparation = spyOn(
    redeemableEarningsService,
    "reinstateRevenueSplits",
  ).mockImplementationOnce(async (params) => {
    const result = await original(params);
    expect(await processStripeEvent(refund)).toBe("ack");
    return result;
  });
  try {
    expect(await processStripeEvent(reinstated)).toBe("retry");
  } finally {
    duringPreparation.mockRestore();
  }
  expect(await balance(buyer.org)).toBe(0);
  expect(
    await creditsService.getTransactionByStripePaymentIntent(
      `stripe:dispute:${disputeId}:reinstated`,
    ),
  ).toBeUndefined();
  const observed = await creditsService.getTransactionByStripePaymentIntent(
    `stripe:refund:ch_${disputeId}:1500`,
  );
  expect(Number(observed?.amount)).toBe(0);
  expect(observed?.metadata?.reversed_usd).toBe(15);
  await expect(paidFlatReservation(buyer.org, 5)).rejects.toBeInstanceOf(
    InsufficientCreditsError,
  );
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(await affiliatePayable(buyer.affiliate)).toBe(0);
  testDatabase.record({
    event: "newer-committed-refund-invalidates-preparation",
    finalBalance: await balance(buyer.org),
  });
});

test("a lost reinstatement acknowledgement retains one complete reinstatement", async () => {
  await reinstatementAcknowledgementLoss(false);
  if (testDatabase.native) await reinstatementAcknowledgementLoss(true);
});

async function reinstatementAcknowledgementLoss(commitReplyLost: boolean) {
  const buyer = await affiliateTopUp();
  const disputeId = `dp_${randomUUID()}`;
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        disputeId,
        750,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  const refund = refundEvent(`ch_${disputeId}`, 1500, buyer.paymentIntentId);
  expect(await processStripeEvent(refund)).toBe("ack");
  const reinstated = disputeEvent(
    "charge.dispute.funds_reinstated",
    disputeId,
    750,
    buyer.paymentIntentId,
  );
  (
    reinstated.body.event.data.object as unknown as {
      charge: Record<string, unknown>;
    }
  ).charge.amount_refunded = 1500;
  const invalidate = creditsService.invalidateCreditCaches.bind(creditsService);
  const record = creditsService.recordDisputeReinstatement.bind(creditsService);
  let ownerPid = 0;
  const owner = spyOn(
    creditsService,
    "recordDisputeReinstatement",
  ).mockImplementationOnce(async (params) => {
    const result = await record(params);
    if (testDatabase.native && params.db) {
      const rows = await sqlRows<{ pid: number }>(
        params.db,
        sql`SELECT pg_backend_pid() AS pid`,
      );
      ownerPid = rows[0]!.pid;
      if (commitReplyLost) testDatabase.loseCommitAck(ownerPid);
    }
    return result;
  });
  const lost = commitReplyLost
    ? undefined
    : spyOn(creditsService, "invalidateCreditCaches").mockImplementationOnce(
        async (org) => {
          await invalidate(org);
          throw new Error("test lost post-commit cache acknowledgement");
        },
      );
  try {
    expect(await processStripeEvent(reinstated)).toBe("retry");
  } finally {
    lost?.mockRestore();
    owner.mockRestore();
  }
  if (commitReplyLost)
    expect(testDatabase.didLoseCommitAck(ownerPid)).toBe(true);
  expect(await balance(buyer.org)).toBe(0);
  expect(
    await creditsService.getTransactionByStripePaymentIntent(
      `stripe:dispute:${disputeId}:reinstated`,
    ),
  ).toMatchObject({ amount: "5.000000" });
  const observedReceipts = await pg().query<{ type: string; amount: string }>(
    `SELECT type,amount FROM credit_transactions WHERE stripe_payment_intent_id IN ($1,$2) ORDER BY type`,
    [
      `stripe:dispute:${disputeId}:reinstated`,
      `stripe:refund:ch_${disputeId}:1500:reinstatement:${disputeId}`,
    ],
  );
  expect(observedReceipts.rows).toEqual([
    { type: "clawback", amount: "-5.000000" },
    { type: "refund", amount: "5.000000" },
  ]);
  const committed = await ledger(buyer.org);
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await ledger(buyer.org)).toEqual(committed);
  expect(await balance(buyer.org)).toBe(0);
  await expect(paidFlatReservation(buyer.org, 5)).rejects.toBeInstanceOf(
    InsufficientCreditsError,
  );
  testDatabase.record({
    event: commitReplyLost
      ? "lost-native-commit-reply-retains-complete-receipts"
      : "lost-post-commit-cache-acknowledgement-retains-complete-receipts",
    ownerPid,
    finalBalance: await balance(buyer.org),
    creditRows: committed.length,
  });
}

test("a retained partial reinstatement repairs its refund without returning credit twice", async () => {
  const buyer = await affiliateTopUp();
  const disputeId = `dp_${randomUUID()}`;
  expect(
    await processStripeEvent(
      disputeEvent(
        "charge.dispute.funds_withdrawn",
        disputeId,
        750,
        buyer.paymentIntentId,
      ),
    ),
  ).toBe("ack");
  expect(
    await processStripeEvent(
      refundEvent(`ch_${disputeId}`, 1500, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  // The original implementation could commit this receipt without its continuation.
  await pg().query(
    "INSERT INTO credit_transactions(organization_id,amount,type,description,stripe_payment_intent_id,metadata) VALUES ($1,5,'refund','retained partial recovery',$2,$3)",
    [
      buyer.org,
      `stripe:dispute:${disputeId}:reinstated`,
      JSON.stringify({
        payment_intent_id: buyer.paymentIntentId,
        source: "charge.dispute.funds_reinstated",
      }),
    ],
  );
  await pg().query("UPDATE organizations SET credit_balance=5 WHERE id=$1", [
    buyer.org,
  ]);
  const reinstated = disputeEvent(
    "charge.dispute.funds_reinstated",
    disputeId,
    750,
    buyer.paymentIntentId,
  );
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await processStripeEvent(reinstated)).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
  expect(
    (await ledger(buyer.org)).filter(([type]) => type === "refund"),
  ).toEqual([["refund", 5]]);
});

test.each(["NaN", "1.000000"])(
  "a retained %s clawback cannot release its hold or reinstate affiliate earnings",
  async (amount) => {
    const buyer = await affiliateTopUp();
    await pg().query("UPDATE organizations SET credit_balance=0 WHERE id=$1", [
      buyer.org,
    ]);
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
    expect(await affiliatePayable(buyer.affiliate)).toBe(0);
    // Retained ledger corruption is not authority to release a real shortfall.
    await pg().query(
      "UPDATE credit_transactions SET amount=$1 WHERE stripe_payment_intent_id=$2",
      [amount, `stripe:dispute:${disputeId}`],
    );
    expect(
      await processStripeEvent(
        disputeEvent(
          "charge.dispute.funds_reinstated",
          disputeId,
          1500,
          buyer.paymentIntentId,
        ),
      ),
    ).toBe("ack");
    expect(await balance(buyer.org)).toBe(0);
    expect(await billingHoldService.getState(buyer.org)).toMatchObject({
      status: "held",
      outstandingUsd: "10.000000",
    });
    expect(await affiliatePayable(buyer.affiliate)).toBe(0);
    expect(
      (
        await pg().query(
          "SELECT id FROM credit_transactions WHERE stripe_payment_intent_id=$1",
          [`stripe:dispute:${disputeId}:reinstated`],
        )
      ).rows,
    ).toEqual([]);
  },
);

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

type ReferredCheckout = Purchase & { appOwner: string; creator: string };

/**
 * A $10 / 500-credit Checkout pack by a buyer referred through an app: it owes
 * $4 (app owner) + $1 (creator) revenue splits. `withSplits` books them, as
 * handleCheckoutSessionCompleted does after the credit grant.
 */
async function referredCheckout(
  withSplits = true,
  referredLater = false,
): Promise<ReferredCheckout> {
  const buyer = await purchase({ credits: "500", cents: 1000, balance: "500" });
  const appOwner = randomUUID();
  const creator = randomUUID();
  for (const userId of [appOwner, creator])
    await pg().query(
      "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
      [userId, buyer.org, `subject_${userId}`],
    );
  const order = await pg().query<{ initiated_by_user_id: string }>(
    "SELECT initiated_by_user_id FROM stripe_checkout_orders WHERE stripe_payment_intent_id=$1",
    [buyer.paymentIntentId],
  );
  const code = randomUUID();
  await pg().query(
    "INSERT INTO referral_codes(id,user_id,code) VALUES ($1,$2,$3)",
    [code, creator, `code-${code}`],
  );
  await pg().query(
    `INSERT INTO referral_signups(referral_code_id,referrer_user_id,referred_user_id,app_owner_id,creator_id,created_at)
     SELECT $1,$2,$3,$4,$2,created_at + $5::integer * interval '1 hour'
     FROM credit_transactions WHERE stripe_payment_intent_id=$6`,
    [
      code,
      creator,
      order.rows[0]?.initiated_by_user_id,
      appOwner,
      // Order the two stored timestamps in the same database clock domain.
      referredLater ? 1 : -1,
      buyer.paymentIntentId,
    ],
  );
  const referred = { ...buyer, appOwner, creator };
  if (withSplits) await bookRevenueSplits(referred);
  return referred;
}

async function bookRevenueSplits(buyer: ReferredCheckout): Promise<void> {
  for (const [userId, source, amount] of [
    [buyer.appOwner, "app_owner_revenue_share", 4],
    [buyer.creator, "creator_revenue_share", 1],
  ] as const) {
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

test("a refund waits for revenue splits that are owed but not booked yet", async () => {
  const buyer = await referredCheckout(false);
  const charge = `ch_${randomUUID()}`;
  expect(
    await processStripeEvent(refundEvent(charge, 1000, buyer.paymentIntentId)),
  ).toBe("retry");
  expect(await balance(buyer.org)).toBe(500);

  await bookRevenueSplits(buyer);
  expect(
    await processStripeEvent(refundEvent(charge, 1000, buyer.paymentIntentId)),
  ).toBe("ack");
  expect(await earnedLedger(buyer.appOwner)).toBe(0);
  expect(await earnedLedger(buyer.creator)).toBe(0);
  expect(await balance(buyer.org)).toBe(0);
});

test("a referral applied after the purchase does not hold the refund", async () => {
  const buyer = await referredCheckout(false, true);
  expect(
    await processStripeEvent(
      refundEvent(`ch_${randomUUID()}`, 1000, buyer.paymentIntentId),
    ),
  ).toBe("ack");
  expect(await balance(buyer.org)).toBe(0);
});
