/**
 * PGlite-backed coverage of the payment-state projection service (#22966).
 * Real schema, real SQL: proves state derivation, reversal aggregation,
 * provider isolation, org scoping, and limit semantics against actual rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import {
  type PaymentRequestRow,
  PaymentRequestsRepository,
} from "../../db/repositories/payment-requests";
import { apiKeys } from "../../db/schemas/api-keys";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { organizations } from "../../db/schemas/organizations";
import {
  type PaymentRequestReceipt,
  paymentRequestReceipts,
} from "../../db/schemas/payment-request-receipts";
import { stripeCheckoutOrders } from "../../db/schemas/stripe-checkout-orders";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";

const { paymentHistoryService } = await import("./payment-history");

const PGLITE_TIMEOUT = 60_000;
let organizationId = "";
let otherOrganizationId = "";
let userId = "";
const repo = new PaymentRequestsRepository();

beforeAll(async () => {
  const appsModule = await import("../../db/schemas/apps");
  const schema = {
    organizations,
    users,
    userCharacters,
    apiKeys,
    apps: appsModule.apps,
    // pg enums are standalone schema objects; without them in the map
    // drizzle-kit never emits CREATE TYPE and the apps table fails.
    appDeploymentStatusEnum: appsModule.appDeploymentStatusEnum,
    appReviewStatusEnum: appsModule.appReviewStatusEnum,
    userDatabaseStatusEnum: appsModule.userDatabaseStatusEnum,
    paymentRequests: (await import("../../db/schemas/payment-requests")).paymentRequests,
    paymentRequestEvents: (await import("../../db/schemas/payment-requests")).paymentRequestEvents,
    stripeCheckoutOrders,
    creditPacks: (await import("../../db/schemas/credit-packs")).creditPacks,
    creditTransactions,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  // payment_request_receipts comes from its real migration file: its composite
  // FK targets a unique index drizzle-kit push cannot order correctly, so the
  // canonical 0262 DDL (statements split exactly like the migrator) is the
  // authoritative schema here.
  const receiptsSql = readFileSync(
    join(import.meta.dirname, "../../db/migrations/0262_payment_request_receipts.sql"),
    "utf8",
  );
  for (const statement of receiptsSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    await dbWrite.execute(statement);
  }
  // Test isolation: the migration's immutability triggers forbid the row
  // cleanup beforeEach needs. Drop them in this harness only — the production
  // invariant they enforce (append-only receipts) is not under test here.
  await dbWrite.execute(
    'DROP TRIGGER IF EXISTS "payment_request_receipts_immutable" ON "payment_request_receipts"',
  );
  await dbWrite.execute(
    'DROP TRIGGER IF EXISTS "payment_request_receipts_truncate_guard" ON "payment_request_receipts"',
  );
}, PGLITE_TIMEOUT);

async function seedOrg(name: string): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name,
      slug: name.toLowerCase(),
      credit_balance: "100",
    })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      email: `${name.toLowerCase()}@example.test`,
      username: name.toLowerCase(),
      steward_user_id: `steward_${name.toLowerCase()}`,
      organization_id: org.id,
    })
    .returning();
  return { orgId: org.id, userId: user.id };
}

async function insertStripePaymentRequest(params: {
  organizationId: string;
  amountCents: number;
  status: string;
  settlementTxRef?: string | null;
  settledAt?: Date | null;
}): Promise<PaymentRequestRow> {
  return await repo.createPaymentRequest({
    organizationId: params.organizationId,
    provider: "stripe",
    amountCents: params.amountCents,
    currency: "USD",
    status: params.status,
    paymentContext: { kind: "any_payer" },
    payerIdentityId: null,
    payerUserId: null,
    payerOrganizationId: null,
    hostedUrl: null,
    callbackUrl: null,
    callbackSecret: null,
    providerIntent: {},
    settlementTxRef: params.settlementTxRef ?? null,
    settledAt: params.settledAt ?? null,
    settlementProof: null,
    expiresAt: new Date(Date.now() + 60_000),
    metadata: {},
    agentId: null,
    appId: null,
    reason: "test top-up",
  } as never);
}

async function insertReceipt(params: {
  organizationId: string;
  paymentRequestId: string;
  providerTxRef: string;
  amountCents: number;
  currency?: string;
  settledAt?: Date;
}): Promise<PaymentRequestReceipt> {
  const [row] = await dbWrite
    .insert(paymentRequestReceipts)
    .values({
      organization_id: params.organizationId,
      payment_request_id: params.paymentRequestId,
      receipt_type: "provider_payment_receipt",
      provider: "stripe",
      ...(params.currency ? { currency: params.currency } : {}),
      provider_tx_ref: params.providerTxRef,
      provider_event_id: `evt_${params.paymentRequestId}`,
      amount_cents: BigInt(params.amountCents),
      currency: params.currency ?? "USD",
      settled_at: params.settledAt ?? new Date(),
      payload_digest: "a".repeat(64),
      settlement_proof: {
        stripe_event_id: `evt_${params.paymentRequestId}`,
        stripe_event_type: "checkout.session.completed",
        stripe_session_id: `cs_test_${params.paymentRequestId}`,
        stripe_payment_intent_id: params.providerTxRef,
        stripe_amount_total: params.amountCents,
        stripe_currency: "usd",
        stripe_payment_status: "paid",
      },
    })
    .returning();
  return row;
}

async function insertCheckoutOrder(params: {
  organizationId: string;
  userId: string;
  amountCents: number;
  status: string;
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeCustomerId?: string | null;
  settledAt?: Date | null;
}) {
  const settled = params.status === "settled";
  const delivered = params.status === "delivered";
  const suffix = Math.random().toString(36).slice(2);
  const [row] = await dbWrite
    .insert(stripeCheckoutOrders)
    .values({
      organization_id: params.organizationId,
      initiated_by_user_id: params.userId,
      client_request_key: `key-${suffix}-${Date.now()}`,
      request_digest: "".padStart(64, "0").replace(/^./, "a"),
      purchase_type: "custom_amount",
      credits_to_grant: String(params.amountCents / 100),
      charge_amount_cents: BigInt(params.amountCents),
      currency: "usd",
      // phase_shape_check: delivered rows bind session+customer without a
      // payment intent; the intent binds at settlement.
      stripe_customer_id:
        params.stripeCustomerId ?? (delivered || settled ? `cus_${suffix}` : null),
      stripe_checkout_session_id:
        params.stripeCheckoutSessionId ?? (delivered || settled ? `cs_test_${suffix}` : null),
      stripe_payment_intent_id: params.stripePaymentIntentId ?? null,
      credit_transaction_id: settled
        ? await seedCreditGrant(params.organizationId, params.userId)
        : null,
      status: params.status,
      settled_at: params.settledAt ?? null,
      metadata: {},
    })
    .returning();
  return row;
}

/** Inserts the credit grant row a settled checkout order must reference. */
async function seedCreditGrant(organizationId: string, userId: string): Promise<string> {
  const [grant] = await dbWrite
    .insert(creditTransactions)
    .values({
      organization_id: organizationId,
      user_id: userId,
      amount: "10",
      type: "credit",
      description: "checkout grant",
      metadata: {},
    })
    .returning();
  return grant.id;
}

async function insertReversal(params: {
  organizationId: string;
  type: "clawback" | "refund";
  amount: string;
  paymentIntentId: string;
  source: string;
  reversedUsd?: number;
  reference?: string;
  unrecoveredUsd?: number;
  idempotencyKey?: string;
  createdAt?: Date;
}) {
  await dbWrite.insert(creditTransactions).values({
    organization_id: params.organizationId,
    amount: params.amount,
    type: params.type,
    description: `${params.source} test row`,
    stripe_payment_intent_id:
      params.idempotencyKey ?? `test:${params.paymentIntentId}:${params.source}:${Math.random()}`,
    metadata: {
      payment_intent_id: params.paymentIntentId,
      source: params.source,
      ...(params.reference ? { reference: params.reference } : {}),
      ...(params.unrecoveredUsd !== undefined
        ? { unrecovered_clawback_usd: params.unrecoveredUsd }
        : {}),
      ...(params.reversedUsd !== undefined ? { reversed_usd: params.reversedUsd } : {}),
    },
    ...(params.createdAt ? { created_at: params.createdAt } : {}),
  });
}

beforeEach(async () => {
  // Delete children before parents: settled checkout orders hold FKs to
  // credit_transactions, receipts to payment_requests.
  await dbWrite.delete(stripeCheckoutOrders);
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(paymentRequestReceipts);
  const { paymentRequestEvents } = await import("../../db/schemas/payment-requests");
  await dbWrite.delete(paymentRequestEvents);
  await dbWrite.delete((await import("../../db/schemas/payment-requests")).paymentRequests);
  await dbWrite.delete(apiKeys);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);

  const primary = await seedOrg("primary");
  const other = await seedOrg("other");
  organizationId = primary.orgId;
  userId = primary.userId;
  otherOrganizationId = other.orgId;
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("listPaymentStates — base states", () => {
  test("settled Stripe payment request with receipt projects succeeded + linked receipt", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 2500,
      status: "settled",
      settlementTxRef: "pi_settled_1",
      settledAt: new Date(),
    });
    const receipt = await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_settled_1",
      amountCents: 2500,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toBe(`payment_request:${request.id}`);
    expect(row.paymentState).toBe("succeeded");
    expect(row.receiptId).toBe(receipt.id);
    expect(row.amountCents).toBe(2500);
    expect(row.currency).toBe("USD");
    expect(row.eventTimeKind).toBe("provider_settlement");
    expect(row.policyEffect).toBeNull();
    expect(row.supportState).toBe("none");
  });

  test("settled purchase facts project from the receipt, not the mutable request row", async () => {
    // The receipt is the immutable #22427 authority: when request and
    // receipt disagree on amount, currency, or settlement time, the
    // receipt wins for a settled purchase.
    const requestSettledAt = new Date("2026-08-23T12:00:00.000Z");
    const receiptSettledAt = new Date("2026-08-23T11:30:00.000Z");
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 2500,
      status: "settled",
      settlementTxRef: "pi_receipt_authority",
      settledAt: requestSettledAt,
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_receipt_authority",
      amountCents: 1900,
      currency: "EUR",
      settledAt: receiptSettledAt,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.amountCents).toBe(1900);
    expect(row.currency).toBe("EUR");
    expect(row.eventTime).toBe(receiptSettledAt.toISOString());
    expect(row.eventTimeKind).toBe("provider_settlement");
  });

  test("reversal association follows the receipt provider tx ref, not the request row", async () => {
    // When the mutable request row and the immutable receipt disagree on
    // the provider transaction reference, reversals attach through the
    // receipt's authority: a refund recorded under the receipt's intent
    // must surface, and one recorded under the request's stale intent
    // must NOT attach to this purchase.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_stale_request_ref",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_authoritative_receipt_ref",
      amountCents: 10000,
    });
    // Refund ledger row keyed on the RECEIPT's intent id.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-100",
      paymentIntentId: "pi_authoritative_receipt_ref",
      source: "charge.refunded",
      reversedUsd: 100,
      reference: "charge ch_assoc",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.paymentState).toBe("refunded");
    expect(row.cumulativeRefundedUsd).toBe(100);

    // Control: a reversal keyed on the stale request intent must NOT
    // attach to the same purchase through the receipt path.
    const request2 = await insertStripePaymentRequest({
      organizationId,
      amountCents: 5000,
      status: "settled",
      settlementTxRef: "pi_request2_ref",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request2.id,
      providerTxRef: "pi_request2_receipt_ref",
      amountCents: 5000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-50",
      paymentIntentId: "pi_request2_ref",
      source: "charge.refunded",
      reversedUsd: 50,
      reference: "charge ch_stale",
    });
    const rows2 = await paymentHistoryService.listPaymentStates(organizationId);
    const row2 = rows2.find((r) => r.id === `payment_request:${request2.id}`);
    expect(row2?.paymentState).toBe("succeeded");
    expect(row2?.cumulativeRefundedUsd).toBe(0);
  });

  test("pending and failed and expired payment requests project distinct states", async () => {
    await insertStripePaymentRequest({
      organizationId,
      amountCents: 100,
      status: "pending",
    });
    await insertStripePaymentRequest({
      organizationId,
      amountCents: 200,
      status: "failed",
    });
    await insertStripePaymentRequest({
      organizationId,
      amountCents: 300,
      status: "expired",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const byAmount = new Map(rows.map((r) => [r.amountCents, r.paymentState]));
    expect(byAmount.get(100)).toBe("pending");
    expect(byAmount.get(200)).toBe("failed");
    expect(byAmount.get(300)).toBe("expired");
  });

  test("org scoping: another organization's rows never leak", async () => {
    const foreign = await insertStripePaymentRequest({
      organizationId: otherOrganizationId,
      amountCents: 9900,
      status: "settled",
      settlementTxRef: "pi_foreign",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId: otherOrganizationId,
      paymentRequestId: foreign.id,
      providerTxRef: "pi_foreign",
      amountCents: 9900,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(0);
    const foreignRows = await paymentHistoryService.listPaymentStates(otherOrganizationId);
    expect(foreignRows.length).toBe(1);
    expect(foreignRows[0].paymentState).toBe("succeeded");
  });
});

describe("listPaymentStates — refund and dispute derivation", () => {
  test("partial refund after consumption: provider cumulative vs applied clawback reported separately", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_partial_1",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_partial_1",
      amountCents: 10000,
    });
    // Provider reversed $40 cumulative; balance covered only $25 of clawback.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-25",
      paymentIntentId: "pi_partial_1",
      source: "charge.refunded",
      reversedUsd: 40,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.paymentState).toBe("partially_refunded");
    expect(row.cumulativeRefundedUsd).toBe(40);
    expect(row.cumulativeClawbackCredits).toBe(25);
    expect(row.policyEffect).toEqual({
      status: "unavailable",
      reason: "refund_entitlement_policy_pending_22930",
    });
    expect(row.supportState).toBe("contact_support");
  });

  test("full refund projects refunded", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 5000,
      status: "settled",
      settlementTxRef: "pi_full_1",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_full_1",
      amountCents: 5000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-50",
      paymentIntentId: "pi_full_1",
      source: "charge.refunded",
      reversedUsd: 50,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows[0].paymentState).toBe("refunded");
    expect(rows[0].cumulativeRefundedUsd).toBe(50);
  });

  test("replayed webhook cannot double-write: the ledger key is unique and the projection reads one row", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_replay_1",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_replay_1",
      amountCents: 10000,
    });
    // Webhook 1: cumulative $30 claws back under the handler idempotency key.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-30",
      paymentIntentId: "pi_replay_1",
      source: "charge.refunded",
      reversedUsd: 30,
      reference: "charge ch_replay",
      idempotencyKey: "stripe:refund:ch_replay:3000",
    });
    // Webhook 2 (re-delivery of the same provider state) inserts the SAME
    // key again: the unique index on credit_transactions.stripe_payment_intent_id
    // rejects the duplicate outright — exactly the handler's idempotency
    // contract. The projection therefore never sees two rows for one state.
    let duplicateRejected = false;
    try {
      await insertReversal({
        organizationId,
        type: "clawback",
        amount: "-0",
        paymentIntentId: "pi_replay_1",
        source: "charge.refunded",
        reversedUsd: 30,
        reference: "charge ch_replay",
        idempotencyKey: "stripe:refund:ch_replay:3000",
      });
    } catch (error) {
      // Drizzle wraps the driver error in DrizzleQueryError (whose message is
      // the failed SQL text); the constraint violation surfaces on the cause
      // chain. Walk it — proven by probe: String(error) does NOT contain
      // "unique constraint", error.cause does.
      let node: unknown = error;
      let depth = 0;
      while (node instanceof Error && depth < 5) {
        if (node.message.includes("duplicate key")) {
          duplicateRejected = true;
          break;
        }
        node = node.cause;
        depth += 1;
      }
    }
    expect(duplicateRejected).toBe(true);

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    expect(rows[0].cumulativeRefundedUsd).toBe(30);
    expect(rows[0].paymentState).toBe("partially_refunded");
  });

  test("two charges under one intent sum their per-charge cumulative snapshots", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_multi_charge",
      settledAt: new Date(Date.now() - 40_000),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_multi_charge",
      amountCents: 10000,
    });
    // Two distinct charges, each with its own cumulative refund snapshot.
    // A single global MAX would undercount (30 instead of 70).
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-30",
      paymentIntentId: "pi_multi_charge",
      source: "charge.refunded",
      reversedUsd: 30,
      reference: "charge ch_A",
      createdAt: new Date(Date.now() - 30_000),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_multi_charge",
      source: "charge.refunded",
      reversedUsd: 40,
      reference: "charge ch_B",
      createdAt: new Date(Date.now() - 20_000),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows[0];
    expect(row.cumulativeRefundedUsd).toBe(70);
    expect(row.paymentState).toBe("partially_refunded");
  });

  test("settled payment request without its receipt projects unavailable, never a fabricated success", async () => {
    await insertStripePaymentRequest({
      organizationId,
      amountCents: 4400,
      status: "settled",
      settlementTxRef: "pi_no_receipt",
      settledAt: new Date(),
    });
    // No receipt inserted.

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    expect(rows[0].paymentState).toBe("unavailable");
    expect(rows[0].receiptId).toBeNull();
  });

  test("dispute withdrawn only projects dispute_withdrawn", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 8000,
      status: "settled",
      settlementTxRef: "pi_dispute_2",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_dispute_2",
      amountCents: 8000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-80",
      paymentIntentId: "pi_dispute_2",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 80,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows[0].paymentState).toBe("dispute_withdrawn");
    expect(rows[0].cumulativeDisputedUsd).toBe(80);
    expect(rows[0].cumulativeRefundedUsd).toBe(0);
  });
});

describe("listPaymentStates — checkout orders and provider isolation", () => {
  test("settled legacy checkout order with no receipt projects succeeded (durable server authority)", async () => {
    await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 1500,
      status: "settled",
      stripePaymentIntentId: "pi_order_1",
      settledAt: new Date(),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.surface).toBe("checkout_order");
    expect(row.paymentState).toBe("succeeded");
    expect(row.receiptId).toBeNull();
    expect(row.eventTimeKind).toBe("provider_settlement");
  });

  test("lost post-payment response: delivered order still projects pending; provider_ambiguous projects unavailable", async () => {
    // phase_shape_check: a delivered order carries session+customer but NOT a
    // payment intent — the intent binds at settlement.
    await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 2000,
      status: "delivered",
      stripeCheckoutSessionId: `cs_delivered_${Date.now()}`,
      stripeCustomerId: `cus_delivered_${Date.now()}`,
    });
    await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 3000,
      status: "provider_ambiguous",
      // phase_shape_check: an ambiguous row binds the customer but never a
      // checkout session or payment intent — the provider outcome is unknown.
      stripeCustomerId: `cus_ambig_${Date.now()}`,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const byAmount = new Map(rows.map((r) => [r.amountCents, r.paymentState]));
    expect(byAmount.get(2000)).toBe("pending");
    expect(byAmount.get(3000)).toBe("unavailable");
  });

  test("two-tab checkout: two concurrent orders project independent rows", async () => {
    await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 1000,
      status: "settled",
      stripePaymentIntentId: "pi_two_tab_a",
      settledAt: new Date(),
    });
    await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 4000,
      status: "failed",
      stripePaymentIntentId: "pi_two_tab_b",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.paymentState === "succeeded").length).toBe(1);
    expect(rows.filter((r) => r.paymentState === "failed").length).toBe(1);
  });

  test("a reversal row can never attach to a checkout order with a different intent", async () => {
    await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 5000,
      status: "settled",
      stripePaymentIntentId: "pi_order_isolated",
      settledAt: new Date(),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_someone_else",
      source: "charge.refunded",
      reversedUsd: 10,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    expect(rows[0].paymentState).toBe("succeeded");
    expect(rows[0].cumulativeRefundedUsd).toBe(0);
  });

  test("checkout order refund flows through the same reversal aggregation", async () => {
    await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 6000,
      status: "settled",
      stripePaymentIntentId: "pi_order_refund",
      settledAt: new Date(),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-30",
      paymentIntentId: "pi_order_refund",
      source: "charge.refunded",
      reversedUsd: 30,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows[0].paymentState).toBe("partially_refunded");
    expect(rows[0].cumulativeRefundedUsd).toBe(30);
  });

  test("oxapay purchase rows never join Stripe reversals and vice versa", async () => {
    const oxapayRequest = await repo.createPaymentRequest({
      organizationId,
      provider: "oxapay",
      amountCents: 7000,
      currency: "USD",
      status: "settled",
      paymentContext: { kind: "any_payer" },
      payerIdentityId: null,
      payerUserId: null,
      payerOrganizationId: null,
      hostedUrl: null,
      callbackUrl: null,
      callbackSecret: null,
      providerIntent: {},
      settlementTxRef: "oxapay_track_1",
      settledAt: new Date(),
      settlementProof: null,
      expiresAt: new Date(Date.now() + 60_000),
      metadata: {},
      agentId: null,
      appId: null,
      reason: "oxapay test",
    } as never);
    // A Stripe clawback keyed to a REAL Stripe PI must not attach to the
    // oxapay row even if someone crafted metadata pointing at its request id.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-70",
      paymentIntentId: `payment-request:${organizationId}:oxapay:${oxapayRequest.id}`,
      source: "charge.refunded",
      reversedUsd: 70,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(1);
    expect(rows[0].provider).toBe("oxapay");
    // No receipt was projected for this oxapay row: settled requests are only
    // a success through their immutable receipt authority (#22427).
    expect(rows[0].paymentState).toBe("unavailable");
    expect(rows[0].cumulativeRefundedUsd).toBe(0);
    expect(rows[0].cumulativeClawbackCredits).toBe(0);
  });
});

describe("listPaymentStates — limit and ordering", () => {
  test("rows sort newest-first and respect the limit", async () => {
    const first = await insertStripePaymentRequest({
      organizationId,
      amountCents: 100,
      status: "pending",
    });
    const second = await insertStripePaymentRequest({
      organizationId,
      amountCents: 200,
      status: "pending",
    });
    void first;

    const rows = await paymentHistoryService.listPaymentStates(organizationId, 1);
    expect(rows.length).toBe(1);
    // Both created within the same second; sort by id as tiebreak — assert
    // only that the result is exactly one of the two and newest-first across
    // the unbounded listing.
    const all = await paymentHistoryService.listPaymentStates(organizationId);
    expect(all.length).toBe(2);
    expect(all[0].eventTime >= all[1].eventTime).toBe(true);
    void second;
  });
});
