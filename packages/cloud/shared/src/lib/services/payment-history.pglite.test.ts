/**
 * PGlite-backed coverage of the payment-state projection service (#22966).
 * Real schema, real SQL: proves state derivation, reversal aggregation,
 * provider isolation, org scoping, and limit semantics against actual rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";

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
  currency?: string;
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeCustomerId?: string | null;
  settledAt?: Date | null;
  createdAt?: Date;
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
      currency: params.currency ?? "usd",
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
      ...(params.createdAt ? { created_at: params.createdAt } : {}),
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
  unrecoveredUsd?: number | null;
  cumulativeTargetUsd?: number;
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
      ...(params.cumulativeTargetUsd !== undefined
        ? { cumulative_clawback_target_usd: params.cumulativeTargetUsd }
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
    expect(row.cumulativeRefundedChargeCurrency).toBe(100);

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
    expect(row2?.cumulativeRefundedChargeCurrency).toBe(0);
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
    expect(row.cumulativeRefundedChargeCurrency).toBe(40);
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
    expect(rows[0].cumulativeRefundedChargeCurrency).toBe(50);
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
    expect(rows[0].cumulativeRefundedChargeCurrency).toBe(30);
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
    expect(row.cumulativeRefundedChargeCurrency).toBe(70);
    expect(row.paymentState).toBe("partially_refunded");
  });

  test("missing-reference cumulative snapshots for one charge take the max, never the sum", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_fallback_snap",
      settledAt: new Date(Date.now() - 40_000),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_fallback_snap",
      amountCents: 10000,
    });
    // Two cumulative snapshots for ONE charge with metadata.reference absent:
    // the production handler keys each as
    // `stripe:refund:<charge>:<cumulative cents>`. A raw idempotency-key
    // fallback would treat these as two authorities and sum $20 + $50 = $70.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-20",
      paymentIntentId: "pi_fallback_snap",
      source: "charge.refunded",
      reversedUsd: 20,
      idempotencyKey: "stripe:refund:ch_snap:2000",
      createdAt: new Date(Date.now() - 30_000),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-50",
      paymentIntentId: "pi_fallback_snap",
      source: "charge.refunded",
      reversedUsd: 50,
      idempotencyKey: "stripe:refund:ch_snap:5000",
      createdAt: new Date(Date.now() - 20_000),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows[0];
    expect(row.cumulativeRefundedChargeCurrency).toBe(50);
    expect(row.paymentState).toBe("partially_refunded");
  });

  test("missing-reference snapshots keep distinct charges additive across the idempotency-key fallback", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_fallback_multi",
      settledAt: new Date(Date.now() - 40_000),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_fallback_multi",
      amountCents: 10000,
    });
    // Two DISTINCT charges, references absent: each snapshot strips to its
    // own charge identity, so the per-authority maxes still add (30 + 40).
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-30",
      paymentIntentId: "pi_fallback_multi",
      source: "charge.refunded",
      reversedUsd: 30,
      idempotencyKey: "stripe:refund:ch_X:3000",
      createdAt: new Date(Date.now() - 30_000),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_fallback_multi",
      source: "charge.refunded",
      reversedUsd: 40,
      idempotencyKey: "stripe:refund:ch_Y:4000",
      createdAt: new Date(Date.now() - 20_000),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows[0];
    expect(row.cumulativeRefundedChargeCurrency).toBe(70);
    expect(row.paymentState).toBe("partially_refunded");
  });

  test("malformed fallback keys keep their own raw authority instead of colliding with a real charge", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_malformed_key",
      settledAt: new Date(Date.now() - 40_000),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_malformed_key",
      amountCents: 10000,
    });
    // A genuine production snapshot for ch_real and an unrelated malformed
    // key whose prefix would naively strip to the same `charge ch_real`.
    // Digits-only suffix enforcement keeps the malformed row on its own raw
    // authority, so the genuine $40 refund is not max-suppressed to $10.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_malformed_key",
      source: "charge.refunded",
      reversedUsd: 40,
      idempotencyKey: "stripe:refund:ch_real:4000",
      createdAt: new Date(Date.now() - 30_000),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_malformed_key",
      source: "charge.refunded",
      reversedUsd: 10,
      idempotencyKey: "stripe:refund:ch_real:not:cents",
      createdAt: new Date(Date.now() - 20_000),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows[0];
    // Distinct authorities stay additive: 40 (genuine) + 10 (malformed raw) = 50.
    expect(row.cumulativeRefundedChargeCurrency).toBe(50);
    expect(row.paymentState).toBe("partially_refunded");
  });

  test("mixed provenance: reference row and key-fallback row for one charge collapse to one authority", async () => {
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_mixed_prov",
      settledAt: new Date(Date.now() - 40_000),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_mixed_prov",
      amountCents: 10000,
    });
    // One snapshot carries metadata.reference, the other lacks it and falls
    // back to the handler key: both must resolve to `charge ch_mixed`.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-25",
      paymentIntentId: "pi_mixed_prov",
      source: "charge.refunded",
      reversedUsd: 25,
      reference: "charge ch_mixed",
      idempotencyKey: "stripe:refund:ch_mixed:2500",
      createdAt: new Date(Date.now() - 30_000),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-60",
      paymentIntentId: "pi_mixed_prov",
      source: "charge.refunded",
      reversedUsd: 60,
      idempotencyKey: "stripe:refund:ch_mixed:6000",
      createdAt: new Date(Date.now() - 20_000),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows[0];
    expect(row.cumulativeRefundedChargeCurrency).toBe(60);
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
    expect(rows[0].cumulativeDisputedChargeCurrency).toBe(80);
    expect(rows[0].cumulativeRefundedChargeCurrency).toBe(0);
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
    expect(rows[0].cumulativeRefundedChargeCurrency).toBe(0);
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
    expect(rows[0].cumulativeRefundedChargeCurrency).toBe(30);
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
    expect(rows[0].cumulativeRefundedChargeCurrency).toBe(0);
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

describe("listPaymentStates — projection boundary contracts (#26752 review)", () => {
  // These tests kill the mutants the original 22-test suite let survive:
  // M1 truncation removal, M2 limit clamp upper bound, M3 currency
  // normalization, M5 stable tie-break, M8 shortfall projection. Each
  // asserts the behavior a consumer observes (row count, DETAIL route
  // reachability, currency casing, ordering stability, money field).

  test("combined surfaces truncate to the bounded limit (M1: rows.slice removal)", async () => {
    // The detail route reaches rows ONLY through this window: if the final
    // slice is dropped, a list surfacing >limit rows silently widens the
    // contract for every consumer that paginates on length.
    const seeds: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i++) {
      seeds.push(
        insertStripePaymentRequest({
          organizationId,
          amountCents: 100 + i,
          status: "pending",
        }),
      );
      seeds.push(
        insertCheckoutOrder({
          organizationId,
          userId,
          amountCents: 200 + i,
          status: "quoted",
        }),
      );
    }
    await Promise.all(seeds);
    const rows = await paymentHistoryService.listPaymentStates(organizationId, 7);
    expect(rows.length).toBe(7);
  });

  test("history beyond 200 rows stays reachable: page 2 via offset and direct detail lookup (M2: clamp removal → losslessness)", async () => {
    // A hard 200-row clamp made persisted purchases beyond the newest 200
    // unreachable from BOTH the list and the detail route (which scanned the
    // same window). The contract is now lossless: limit is bounded by
    // PAYMENT_STATES_MAX_PAGE (500, the pagination family's list maximum),
    // pages compose through offset, countPaymentStates reports the real
    // total, and findPaymentStateById resolves any row by stable id — so row
    // 201 must remain reachable from every surface (#26752 review).
    const seeds: Array<Promise<unknown>> = [];
    // 230 requests + 10 orders = 240 rows: strictly more than the old 200-row
    // clamp so the detail-lookup target below genuinely sits beyond the
    // newest-200 window the clamp served (#26752 r5).
    for (let i = 0; i < 230; i++) {
      seeds.push(
        insertStripePaymentRequest({
          organizationId,
          amountCents: 100,
          status: "pending",
          settlementTxRef: `pi_clamp_${i}`,
        }),
      );
    }
    for (let i = 0; i < 10; i++) {
      seeds.push(
        insertCheckoutOrder({
          organizationId,
          userId,
          amountCents: 200,
          status: "quoted",
        }),
      );
    }
    await Promise.all(seeds);
    const total = await paymentHistoryService.countPaymentStates(organizationId);
    expect(total).toBe(240);

    // Ordering divergence: the OLDEST-created request (created first, at
    // index 0 of the seed loop) receives the NEWEST event — a reversal
    // ledger row written after everything else, attaching through its
    // settlement tx ref `pi_clamp_0`. Its derived eventTime jumps to the
    // front while its pagination key stays at the very back of the merged
    // ordering: under the old design (prefix by created_at, page by
    // eventTime) this row fell out of every page. Full traversal must
    // still visit it exactly once (#26752 review P1).
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-1",
      paymentIntentId: "pi_clamp_0",
      source: "charge.refunded",
      reversedUsd: 1,
    });
    const allRows = await paymentHistoryService.listPaymentStates(organizationId, 500, 0);
    expect(allRows.length).toBe(240);
    // The divergent purchase is identifiable by its reversal projection: it
    // is the only request carrying cumulativeRefundedChargeCurrency = 1.
    const oldestId = allRows.find(
      (r) =>
        r.surface === "payment_request" &&
        r.amountCents === 100 &&
        r.cumulativeRefundedChargeCurrency === 1,
    );
    expect(oldestId).toBeDefined();
    expect(oldestId?.id).toBeTruthy();
    // ...and it still appears exactly once in a full page walk at limit 50.
    const seen = new Set<string>();
    for (let offset = 0; offset < 240; offset += 50) {
      const page = await paymentHistoryService.listPaymentStates(organizationId, 50, offset);
      for (const row of page) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(240);
    expect(seen.has(oldestId?.id as string)).toBe(true);

    // A row beyond the old 200-clamp position is reachable by stable detail id.
    const hiddenRow = [...seen].find((id) => id === oldestId?.id) as string;
    // The window guard: the target must genuinely sit outside the newest 200
    // rows, so a regression of findPaymentStateById to scanning only
    // listPaymentStates(org, 200, 0) fails here instead of passing vacuously.
    const newest200 = await paymentHistoryService.listPaymentStates(organizationId, 200, 0);
    expect(newest200.length).toBe(200);
    expect(newest200.some((row) => row.id === hiddenRow)).toBe(false);
    const detail = await paymentHistoryService.findPaymentStateById(organizationId, hiddenRow);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(hiddenRow);
    expect(detail?.amountCents).toBe(100);
    // The divergence reversal projected onto the detail path identically.
    expect(detail?.cumulativeRefundedChargeCurrency).toBe(1);

    // The page cap is the pagination family's list maximum, not 200.
    const wide = await paymentHistoryService.listPaymentStates(organizationId, 600);
    expect(wide.length).toBe(240);
  });

  test("sub-millisecond created_at precision keeps SQL and page ranking identical within a surface", async () => {
    // Two checkout orders whose created_at values differ ONLY in
    // PostgreSQL microseconds (identical after JS Date ms conversion),
    // inserted via raw SQL so the µs digits survive, with CONTROLLED ids:
    // the SQL-newer row (later µs) carries the lexicographically SMALLER
    // id, so any JS re-ranking (Date.getTime() + localeCompare) inverts the
    // SQL order — the exact round-2 P1 stranding setup. With the window
    // selected entirely in SQL, walking limit=1 pages returns both rows
    // exactly once.
    await dbWrite.execute(sql`
      INSERT INTO stripe_checkout_orders (
        id, organization_id, initiated_by_user_id, client_request_key,
        request_digest, purchase_type, credits_to_grant, charge_amount_cents,
        currency, status, created_at, metadata
      ) VALUES
        ('11111111-1111-4111-8111-00000000000a', ${organizationId}, ${userId},
         'prec-key-a', repeat('a', 64), 'custom_amount', '1', 100, 'usd',
         'quoted', '2026-08-27T12:00:00.000900Z', '{}'),
        ('11111111-1111-4111-8111-00000000000b', ${organizationId}, ${userId},
         'prec-key-b', repeat('a', 64), 'custom_amount', '2', 200, 'usd',
         'quoted', '2026-08-27T12:00:00.000200Z', '{}')
    `);

    // SQL ranking: the id ...a row (created .000900Z, newer µs) outranks
    // ...b (.000200Z) despite ...a being lexicographically smaller — the
    // inversion any JS ms+localeCompare merge would get wrong.
    const seen: string[] = [];
    for (let offset = 0; offset < 4; offset++) {
      const page = await paymentHistoryService.listPaymentStates(organizationId, 1, offset);
      if (page.length === 0) break;
      expect(seen.includes(page[0].id)).toBe(false);
      seen.push(page[0].id);
    }
    expect(seen.length).toBe(2);
    expect(new Set(seen)).toEqual(
      new Set([
        "checkout_order:11111111-1111-4111-8111-00000000000a",
        "checkout_order:11111111-1111-4111-8111-00000000000b",
      ]),
    );
  });

  test("cross-surface UUID collision keeps pagination exact — surface partitions hydration", async () => {
    // Authority ids are unique per TABLE, not across tables: a
    // payment_request and a checkout_order may share one UUID. The union
    // window must carry the surface with the id (final SQL tie-breaker) and
    // hydration must query each table only with its OWN ids — otherwise a
    // limit=1 page hydrates both rows and the walk duplicates one and
    // strands the other (#26752 review r3 P1).
    const sharedId = "11111111-2222-4222-8222-0000000000aa";
    // Identical created_at in both tables: (created_at, id) is fully tied, so
    // the surface discriminator is the ONLY thing separating the rows — this
    // directly exercises the final SQL tie-breaker, not just partitioning.
    const tiedInstant = "2026-08-27T12:00:02.000000Z";
    await dbWrite.execute(sql`
      INSERT INTO stripe_checkout_orders (
        id, organization_id, initiated_by_user_id, client_request_key,
        request_digest, purchase_type, credits_to_grant, charge_amount_cents,
        currency, status, created_at, metadata
      ) VALUES
        (${sharedId}, ${organizationId}, ${userId},
         'collide-key', repeat('a', 64), 'custom_amount', '1', 100, 'usd',
         'quoted', ${tiedInstant}, '{}')
    `);
    await dbWrite.execute(sql`
      INSERT INTO payment_requests (
        id, organization_id, provider, amount_cents, currency, status,
        payment_context, expires_at, created_at, metadata
      ) VALUES
        (${sharedId}, ${organizationId}, 'stripe', 200, 'USD', 'pending',
         '{"kind":"any_payer"}'::jsonb, now() + interval '1 hour',
         ${tiedInstant}, '{}'::jsonb)
    `);

    // Each limit=1 page contains exactly ONE row; the walk covers both
    // prefixed ids exactly once.
    const seen: string[] = [];
    for (let offset = 0; offset < 4; offset++) {
      const page = await paymentHistoryService.listPaymentStates(organizationId, 1, offset);
      expect(page.length).toBeLessThan(2);
      if (page.length === 0) break;
      expect(seen.includes(page[0].id)).toBe(false);
      seen.push(page[0].id);
    }
    expect(seen.length).toBe(2);
    expect(new Set(seen)).toEqual(
      new Set([`payment_request:${sharedId}`, `checkout_order:${sharedId}`]),
    );
  });

  test("findPaymentStateById resolves either surface by stable id, org-scoped, with full reversal parity", async () => {
    // The detail surface must agree with the list projection row-for-row
    // (same projector), reject foreign orgs, and 404 (null) on ids no
    // authority ever produced.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 5000,
      status: "settled",
      settlementTxRef: "pi_detail_parity",
      settledAt: new Date("2026-08-20T09:00:00Z"),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_detail_parity",
      amountCents: 5000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-25",
      paymentIntentId: "pi_detail_parity",
      source: "charge.refunded",
      reversedUsd: 25,
      reference: "charge ch_detail",
    });
    const order = await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 3000,
      status: "settled",
      stripePaymentIntentId: "pi_order_detail",
      settledAt: new Date("2026-08-21T10:00:00Z"),
    });

    const listRows = await paymentHistoryService.listPaymentStates(organizationId);
    const requestListRow = listRows.find((r) => r.id === `payment_request:${request.id}`);
    const orderListRow = listRows.find((r) => r.id === `checkout_order:${order.id}`);
    expect(requestListRow).toBeDefined();
    expect(orderListRow).toBeDefined();

    const requestDetail = await paymentHistoryService.findPaymentStateById(
      organizationId,
      `payment_request:${request.id}`,
    );
    expect(requestDetail).not.toBeNull();
    expect(requestDetail).toEqual(requestListRow);
    expect(requestDetail?.paymentState).toBe("partially_refunded");
    expect(requestDetail?.cumulativeRefundedChargeCurrency).toBe(25);

    const orderDetail = await paymentHistoryService.findPaymentStateById(
      organizationId,
      `checkout_order:${order.id}`,
    );
    expect(orderDetail).not.toBeNull();
    expect(orderDetail).toEqual(orderListRow);

    // Tenant isolation: the other org never resolves this org's rows.
    const foreign = await paymentHistoryService.findPaymentStateById(
      otherOrganizationId,
      `payment_request:${request.id}`,
    );
    expect(foreign).toBeNull();
    const foreignOrder = await paymentHistoryService.findPaymentStateById(
      otherOrganizationId,
      `checkout_order:${order.id}`,
    );
    expect(foreignOrder).toBeNull();

    // Unknown surfaces and nonexistent authorities are null, not errors.
    expect(
      await paymentHistoryService.findPaymentStateById(organizationId, "wire_transfer:nope"),
    ).toBeNull();
    expect(
      await paymentHistoryService.findPaymentStateById(
        organizationId,
        `checkout_order:${"0".repeat(32)}`,
      ),
    ).toBeNull();
  });

  test("currency is uppercased from the ledger's lowercase storage (M3: .toUpperCase() drop)", async () => {
    // The checkout-orders table enforces LOWERCASE currency codes
    // (stripe_checkout_orders_currency_check: currency = lower(currency)),
    // so every checkout row reaches the projection as "eur"/"usd". The
    // PaymentStateRow contract documents "Uppercase currency code as
    // normalized from the owning authority" — without normalization the
    // storage casing leaks into a documented API contract and consumers
    // cannot compare codes without their own casing pass.
    const order = await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 1900,
      status: "settled",
      currency: "eur",
      stripePaymentIntentId: "pi_eur_casing",
      settledAt: new Date(),
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-19",
      paymentIntentId: "pi_eur_casing",
      source: "charge.refunded",
      reversedUsd: 19,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `checkout_order:${order.id}`);
    expect(row).toBeDefined();
    expect(row?.currency).toBe("EUR");
    expect(row?.cumulativeRefundedChargeCurrency).toBe(19);
    // Refund status compares cumulative reversal vs purchase amount in the
    // SAME currency: 19.00 EUR refunded of 19.00 EUR purchase = refunded.
    expect(row?.paymentState).toBe("refunded");
  });

  test("equal eventTime rows order by stable row-id tie-break (M5: tie-break swap)", async () => {
    const stamp = new Date("2026-08-27T10:00:00Z");
    // Deterministic construction: the projection concatenates request rows
    // BEFORE order rows, but the id tie-break must sort `checkout_order:*`
    // before `payment_request:*` (localeCompare ascending). With equal
    // eventTimes, a mutant that returns only timeDelta keeps the input
    // order ([payment_request, checkout_order]) and fails here regardless
    // of any generated uuid — no coincidence can mask it.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 100,
      status: "settled",
      settlementTxRef: "pi_tie_req",
      settledAt: stamp,
    });
    // This request is created AFTER the order but settles to the SAME
    // eventTime: its newer createdAt places it FIRST in the window while
    // the id tie-break must still sort `checkout_order:*` before it. This
    // is exactly the prefix/eventTime divergence the stable ordering
    // guarantees survives.
    const lateRequest = await insertStripePaymentRequest({
      organizationId,
      amountCents: 300,
      status: "settled",
      settlementTxRef: "pi_tie_late",
      settledAt: stamp,
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_tie_req",
      amountCents: 100,
      settledAt: stamp,
    });
    const order = await insertCheckoutOrder({
      organizationId,
      userId,
      amountCents: 200,
      status: "settled",
      stripePaymentIntentId: "pi_tie_order",
      settledAt: stamp,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    expect(rows.length).toBe(3);
    // Exact expected order: all three rows share the eventTime, so the id
    // tie-break alone decides — `checkout_order:*` sorts before BOTH
    // payment_request rows regardless of creation order.
    expect(rows.map((r) => r.id)).toEqual(
      [
        `checkout_order:${order.id}`,
        `payment_request:${request.id}`,
        `payment_request:${lateRequest.id}`,
      ].sort((a, b) => a.localeCompare(b)),
    );
    // Repeated calls produce the IDENTICAL order (the UI stability promise).
    const again = await paymentHistoryService.listPaymentStates(organizationId);
    expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  test("clawback shortfall projects into unrecoveredShortfallCredits (M8: += 0)", async () => {
    // Customer-visible money field: the reviewer's mutation zeroed the
    // accumulation and 22 tests stayed green. A partial clawback that could
    // not recover the full reversal must surface the shortfall.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 5000,
      status: "settled",
      settlementTxRef: "pi_shortfall",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_shortfall",
      amountCents: 5000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-30",
      paymentIntentId: "pi_shortfall",
      source: "charge.refunded",
      reversedUsd: 50,
      unrecoveredUsd: 20,
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.cumulativeRefundedChargeCurrency).toBe(50);
    expect(row?.cumulativeClawbackCredits).toBe(30);
    expect(row?.unrecoveredShortfallCredits).toBe(20);
    expect(row?.paymentState).toBe("refunded");
  });

  test("cumulative shortfall snapshots never sum: outstanding = max target − net applied (#26752 P1#3)", async () => {
    // The writer's per-row shortfall snapshots are cumulative deltas: a
    // later row's requested_amount already carries earlier under-recovery.
    // Summing them (the old reader) inflated the outstanding shortfall
    // forever ($15 forever in the reviewer's repro). The authoritative
    // derivation is max cumulative clawback target − net applied credits.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_catchup",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_catchup",
      amountCents: 10000,
    });
    // Writer sequence from the review (credit units): row1 target 40,
    // balance 25 → applied 25, shortfall 15; row2 cumulative target 60,
    // prior applied 25, balance 10 → requested 35, applied 10, shortfall 25.
    // Current outstanding = 60 − 35 = 25 (NOT 15+25=40).
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-25",
      paymentIntentId: "pi_catchup",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 15,
      cumulativeTargetUsd: 40,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_catchup:4000",
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_catchup",
      source: "charge.refunded",
      reversedUsd: 60,
      unrecoveredUsd: 25,
      cumulativeTargetUsd: 60,
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_catchup:6000",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.cumulativeClawbackCredits).toBe(35);
    // Derived outstanding, not the 40 the snapshot sum would report.
    expect(row?.unrecoveredShortfallCredits).toBe(25);
  });

  test("full catch-up later clears the outstanding shortfall completely (#26752 P1#3)", async () => {
    // A later clawback that covers the remaining target must drive the
    // outstanding shortfall to zero — under snapshot-summing the stale $15
    // lingered forever.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_full_catchup",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_full_catchup",
      amountCents: 10000,
    });
    // Both rows carry the production `reference` authority for the same
    // charge, so their cumulative targets collapse to ONE authority (max
    // 40) instead of two raw fallback authorities.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-25",
      paymentIntentId: "pi_full_catchup",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 15,
      cumulativeTargetUsd: 40,
      reference: "charge ch_full_catchup",
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_full_catchup:4000",
    });
    // Later full recovery: cumulative target still 40, applied now 40,
    // shortfall snapshot 0 (GREATEST(40-40,0)).
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-15",
      paymentIntentId: "pi_full_catchup",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 40,
      reference: "charge ch_full_catchup",
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_full_catchup:4000:2",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.cumulativeClawbackCredits).toBe(40);
    expect(row?.unrecoveredShortfallCredits).toBe(0);
  });

  test("dispute reinstatement closes the outstanding shortfall when it is the latest reversal (#26752 r2)", async () => {
    // A reinstatement is the reversal being OVERTURNED — the credits were
    // restored and the clawback no longer asserts a debt. The outstanding
    // shortfall must read zero, not (target − net applied).
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_terminal_reinstate",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_terminal_reinstate",
      amountCents: 10000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_terminal_reinstate",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 40,
      // Writer-honest snapshot: requested 40, applied 40 → snapshot 0.
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 40,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_terminal:4000",
      reference: "dispute dp_terminal",
    });
    await insertReversal({
      organizationId,
      type: "refund",
      amount: "40",
      paymentIntentId: "pi_terminal_reinstate",
      source: "charge.dispute.funds_reinstated",
      reversedUsd: 40,
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_terminal:reinstate",
      reference: "dispute dp_terminal",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.paymentState).toBe("dispute_reinstated");
    expect(row?.cumulativeClawbackCredits).toBe(40);
    expect(row?.reinstatedCredits).toBe(40);
    // Overturned reversal: zero outstanding, never 40 or 15.
    expect(row?.unrecoveredShortfallCredits).toBe(0);
  });

  test("a later smaller-authority target never inflates outstanding: applied credits cap at the intent-wide max target (#26752 r3)", async () => {
    // The writer's requested_amount = GREATEST(target − prior_applied_across_
    // the_WHOLE_intent, 0): after charge A's 60 was fully applied, a charge-B
    // event with target 40 computes requested 0 and inserts NO row. The
    // projection mirrors that semantics — the intent-wide max target minus
    // net applied — so this ledger (only A's row exists) reports 0, and a
    // hypothetical B row could not push total targets past what the writer
    // would ever request. Per-authority summation would fabricate 40.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 20000,
      status: "settled",
      settlementTxRef: "pi_two_charges",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_two_charges",
      amountCents: 20000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-60",
      paymentIntentId: "pi_two_charges",
      source: "charge.refunded",
      reversedUsd: 60,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 60,
      reference: "charge ch_a",
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_a:6000",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    // Intent-wide max target 60, applied 60 → 0 outstanding. A charge-B
    // target 40 arriving later would compute requested 0 in the writer and
    // insert nothing; the projection cannot assert more than the ledger.
    expect(row?.unrecoveredShortfallCredits).toBe(0);
  });

  test("a partial reinstatement never zeroes outstanding debt from other reversals (#26752 r3)", async () => {
    // Reinstatement restores min(dispute.amount, applied clawback) — a
    // PARTIAL reinstatement (10 of 40 applied) must flow through net
    // applied, not clear the outstanding shortfall. Only a full
    // reinstatement (restored >= applied) closes the debt.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_partial_reinstate",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_partial_reinstate",
      amountCents: 10000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_partial_reinstate",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 40,
      // Writer-honest snapshot: requested 40 (target 40, no prior
      // reversals), applied 40 → snapshot 0.
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 40,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_partial:4000",
    });
    // PARTIAL reinstatement: dispute.amount/100 = 10 < applied 40 → the
    // writer records reinstated_usd = 10.
    await insertReversal({
      organizationId,
      type: "refund",
      amount: "10",
      paymentIntentId: "pi_partial_reinstate",
      source: "charge.dispute.funds_reinstated",
      reversedUsd: 40,
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_partial:reinstated",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.paymentState).toBe("dispute_reinstated");
    // Partial reinstatement: derived path — target 40 − net applied
    // (40 − 10 = 30) = 10 outstanding. NOT zeroed.
    expect(row?.unrecoveredShortfallCredits).toBe(10);
  });

  test("an explicit null shortfall snapshot never masquerades as zero (#26752 r3)", async () => {
    // finiteNumber(null) coerces Number(null) === 0; a metadata null must
    // be treated as absent, leaving the older real snapshot standing.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 5000,
      status: "settled",
      settlementTxRef: "pi_null_snapshot",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_null_snapshot",
      amountCents: 5000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-25",
      paymentIntentId: "pi_null_snapshot",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 15,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "legacy:older",
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_null_snapshot",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: null,
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
      idempotencyKey: "legacy:newer-null",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    // The null snapshot is absent data, not a recorded zero — the older
    // real 15 stands.
    expect(row?.unrecoveredShortfallCredits).toBe(15);
  });

  test("legacy newest zero snapshot clears an older shortfall (#26752 r2)", async () => {
    // Zero is a valid recorded snapshot: a later legacy row recording
    // shortfall 0 (recovery caught up) must clear the older 15, not be
    // skipped by a `> 0` guard.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 5000,
      status: "settled",
      settlementTxRef: "pi_legacy_zero",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_legacy_zero",
      amountCents: 5000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-25",
      paymentIntentId: "pi_legacy_zero",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 15,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "legacy:older",
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-15",
      paymentIntentId: "pi_legacy_zero",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 0,
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
      idempotencyKey: "legacy:newer",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.unrecoveredShortfallCredits).toBe(0);
  });

  test("a full reinstatement cycle re-bases debt at the newer event's target (#26752 r4)", async () => {
    // Writer sequence (RP r4 finding 1): target 60 fully applied → dispute
    // fully reinstated (net prior total back to 0) → a NEWER reversal with
    // target 40 applies 40 with no shortfall. The current debt basis is the
    // NEWEST recorded target (40), not the historical max (60) — max-target
    // would fabricate 60 − 40 = 20 of debt the ledger no longer asserts.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 20000,
      status: "settled",
      settlementTxRef: "pi_rebase_cycle",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_rebase_cycle",
      amountCents: 20000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-60",
      paymentIntentId: "pi_rebase_cycle",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 60,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 60,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_rebase:6000",
      reference: "dispute dp_rebase",
    });
    await insertReversal({
      organizationId,
      type: "refund",
      amount: "60",
      paymentIntentId: "pi_rebase_cycle",
      source: "charge.dispute.funds_reinstated",
      reversedUsd: 60,
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_rebase:reinstated",
      reference: "dispute dp_rebase",
    });
    // Newer refund event with a SMALLER cumulative target: the writer's
    // prior_reversal.total is 0 after the reinstatement, so requested 40
    // applies in full — no shortfall row is implied, but the target row
    // itself records the intent's current debt basis.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_rebase_cycle",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 40,
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_rebase:4000",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.cumulativeClawbackCredits).toBe(100);
    expect(row?.reinstatedCredits).toBe(60);
    // Newest target 40 − net applied (100 − 60 = 40) = 0 outstanding.
    // Historical max (60) would fabricate 20 of phantom debt.
    expect(row?.unrecoveredShortfallCredits).toBe(0);
  });

  test("legacy partial reinstatement grows the snapshot shortfall by the restored credits (#26752 r4)", async () => {
    // RP r4 finding 2: legacy rows (no cumulative target) with a PARTIAL
    // reinstatement AFTER the newest snapshot. The writer's snapshot already
    // nets older reinstatements, but a later reinstatement un-applies
    // credits the snapshot never saw: outstanding = snapshot + reinstated
    // since that snapshot (RP's case: 0 + 4 = 4).
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_legacy_partial_reinstate",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_legacy_partial_reinstate",
      amountCents: 10000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_legacy_partial_reinstate",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 10,
      unrecoveredUsd: 0,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_legacy_partial:1000",
    });
    // PARTIAL reinstatement (4 of 10 applied) recorded AFTER the snapshot:
    // the credits were handed back, so 4 are outstanding again.
    await insertReversal({
      organizationId,
      type: "refund",
      amount: "4",
      paymentIntentId: "pi_legacy_partial_reinstate",
      source: "charge.dispute.funds_reinstated",
      reversedUsd: 4,
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_legacy_partial:reinstated",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.paymentState).toBe("dispute_reinstated");
    // Snapshot 0 + reinstated-since-snapshot 4 = 4 outstanding, not 0.
    expect(row?.unrecoveredShortfallCredits).toBe(4);
  });

  test("a newer smaller target without a reinstatement cycle never cancels the older larger target (#26752 r5)", async () => {
    // RP r4 finding 1, sharpened: target 60 applies only 30 (balance ran
    // out); later a target-40 event sees prior total 30, requests and
    // applies 10. The older 60 is still 20 unmet — nothing in the writer
    // cancels it. Newest-target would wrongly report 40 − 40 = 0.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 20000,
      status: "settled",
      settlementTxRef: "pi_no_cycle_reset",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_no_cycle_reset",
      amountCents: 20000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-30",
      paymentIntentId: "pi_no_cycle_reset",
      source: "charge.refunded",
      reversedUsd: 60,
      unrecoveredUsd: 30,
      cumulativeTargetUsd: 60,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_no_cycle:6000",
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_no_cycle_reset",
      source: "charge.refunded",
      reversedUsd: 40,
      unrecoveredUsd: 20,
      cumulativeTargetUsd: 40,
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_no_cycle:4000",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.cumulativeClawbackCredits).toBe(40);
    // Max target since (no) cycle = 60 − net applied 40 = 20 still owed —
    // the newest target (40 − 40 = 0) would erase real debt.
    expect(row?.unrecoveredShortfallCredits).toBe(20);
  });

  test("partial reinstatement keeps post-cycle clawbacks owed against the max target since the cycle (#26752 r5)", async () => {
    // RP r4 finding 1, second scenario: 60 applied → only 20 reinstated
    // (NOT a full cycle — prior total 40 stays) → target-50 event requests
    // and applies 10 more. Max target since the cycle is still 60 (the
    // partial reinstatement never zeroed it): 60 − (70 − 20) = 10 owed.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 20000,
      status: "settled",
      settlementTxRef: "pi_partial_cycle",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_partial_cycle",
      amountCents: 20000,
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-60",
      paymentIntentId: "pi_partial_cycle",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 60,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 60,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_partial_cycle:6000",
    });
    // PARTIAL reinstatement: 20 of 60 restored — not a cycle boundary.
    await insertReversal({
      organizationId,
      type: "refund",
      amount: "20",
      paymentIntentId: "pi_partial_cycle",
      source: "charge.dispute.funds_reinstated",
      reversedUsd: 20,
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_partial_cycle:reinstated",
    });
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_partial_cycle",
      source: "charge.refunded",
      reversedUsd: 50,
      unrecoveredUsd: 10,
      cumulativeTargetUsd: 50,
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_partial_cycle:5000",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.cumulativeClawbackCredits).toBe(70);
    expect(row?.reinstatedCredits).toBe(20);
    // Max target since (no full) cycle = 60 − net applied (70 − 20 = 50)
    // = 10 owed. Newest-target (50 − 50 = 0) would erase real debt.
    expect(row?.unrecoveredShortfallCredits).toBe(10);
  });

  test("a full dispute reinstatement never erases an unrelated authority's shortfall (#26752 r6)", async () => {
    // RP r5 finding: balance 10; dispute target 10 applies 10; unrelated
    // refund target 60 requests 50 but applies 0 (requested > 0 passes the
    // writer's insertion guard — insertion does NOT require applied > 0);
    // then the dispute fully reinstates 10. Aggregate reinstated (10) >=
    // aggregate applied (10), but the refund's recorded shortfall of 50 is
    // unmet debt from a different authority — it survives the cycle.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 20000,
      status: "settled",
      settlementTxRef: "pi_unrelated_shortfall",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_unrelated_shortfall",
      amountCents: 20000,
    });
    // Dispute clawback: target 10, applied 10, snapshot 0.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-10",
      paymentIntentId: "pi_unrelated_shortfall",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 10,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 10,
      reference: "dispute dp_unrelated",
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_unrelated:1000",
    });
    // Unrelated refund clawback: target 60, prior total 10 → requested 50,
    // balance 0 → applied 0, snapshot 50. Insertion passed because
    // requested > 0.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "0",
      paymentIntentId: "pi_unrelated_shortfall",
      source: "charge.refunded",
      reversedUsd: 60,
      unrecoveredUsd: 50,
      cumulativeTargetUsd: 60,
      reference: "charge ch_unrelated",
      createdAt: new Date("2026-08-20T11:00:00.000Z"),
      idempotencyKey: "stripe:refund:ch_unrelated:6000",
    });
    // The dispute is fully reinstated — its own debt closes, but the
    // refund's 50 survives.
    await insertReversal({
      organizationId,
      type: "refund",
      amount: "10",
      paymentIntentId: "pi_unrelated_shortfall",
      source: "charge.dispute.funds_reinstated",
      reversedUsd: 10,
      createdAt: new Date("2026-08-20T12:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_unrelated:reinstated",
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.cumulativeClawbackCredits).toBe(10);
    expect(row?.reinstatedCredits).toBe(10);
    expect(row?.paymentState).toBe("dispute_reinstated");
    // The refund's unmet 50 survives the dispute's full reinstatement, and
    // the reinstatement's 10 restored credits are debt again (RP's own
    // arithmetic: 50 snapshot + 10 later reinstatement = 60; equivalently
    // max target 60 − net applied 0 = 60). The aggregate zero branch must
    // not erase another authority's debt.
    expect(row?.unrecoveredShortfallCredits).toBe(60);
  });

  test("a legacy reinstatement without reference still overturns its own dispute via clawback_key (#26752 r7)", async () => {
    // RP r7 finding: production reinstatement rows carry
    // clawback_key = the clawback row's idempotency key. When the
    // reference is absent, that key must resolve to the SAME fallback
    // authority the clawback row itself derives (stripe:dispute:dp_1) —
    // otherwise the dispute is never overturned and a fully reinstated
    // 40-credit dispute would project 40 outstanding forever.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_legacy_clawback_key",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_legacy_clawback_key",
      amountCents: 10000,
    });
    // Dispute clawback WITHOUT reference: fallback authority
    // dispute:fallback:stripe:dispute:dp_legacy_key:4000 (its own
    // idempotency key), target 40 fully applied.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_legacy_clawback_key",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 40,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 40,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_legacy_key:4000",
    });
    // Full reinstatement WITHOUT reference but carrying the clawback row's
    // key — must reach the dispute's debt entry and overturn it.
    await dbWrite.insert(creditTransactions).values({
      organization_id: organizationId,
      amount: "40",
      type: "refund",
      description: "charge.dispute.funds_reinstated test row",
      stripe_payment_intent_id: "stripe:dispute:dp_legacy_key:4000:reinstated",
      metadata: {
        payment_intent_id: "pi_legacy_clawback_key",
        source: "charge.dispute.funds_reinstated",
        clawback_key: "stripe:dispute:dp_legacy_key:4000",
      },
      created_at: new Date("2026-08-20T11:00:00.000Z"),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.paymentState).toBe("dispute_reinstated");
    expect(row?.cumulativeClawbackCredits).toBe(40);
    expect(row?.reinstatedCredits).toBe(40);
    // The dispute's own reinstatement overturned it: 0 outstanding, not 40.
    expect(row?.unrecoveredShortfallCredits).toBe(0);
  });

  test("mixed-provenance reinstatement (reference present, legacy clawback without) still overturns its dispute (#26752 r8)", async () => {
    // RP r8 finding: a legacy clawback without reference derives the
    // fallback authority "dispute:fallback:<key>", while a later
    // reinstatement WITH reference derives "dispute <id>" — different
    // spellings of the same dispute never paired. The reinstatement
    // credits both spellings (its clawback_key names the clawback row's
    // key), so either provenance reaches the debt entry.
    const request = await insertStripePaymentRequest({
      organizationId,
      amountCents: 10000,
      status: "settled",
      settlementTxRef: "pi_mixed_provenance",
      settledAt: new Date(),
    });
    await insertReceipt({
      organizationId,
      paymentRequestId: request.id,
      providerTxRef: "pi_mixed_provenance",
      amountCents: 10000,
    });
    // LEGACY clawback: no reference — fallback authority
    // dispute:fallback:stripe:dispute:dp_mixed:4000.
    await insertReversal({
      organizationId,
      type: "clawback",
      amount: "-40",
      paymentIntentId: "pi_mixed_provenance",
      source: "charge.dispute.funds_withdrawn",
      reversedUsd: 40,
      unrecoveredUsd: 0,
      cumulativeTargetUsd: 40,
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
      idempotencyKey: "stripe:dispute:dp_mixed:4000",
    });
    // Reinstatement WITH reference AND clawback_key: the reference-derived
    // authority ("dispute dp_mixed") does not exist as a debt entry — the
    // clawback_key spelling does and receives the credit.
    await dbWrite.insert(creditTransactions).values({
      organization_id: organizationId,
      amount: "40",
      type: "refund",
      description: "charge.dispute.funds_reinstated test row",
      stripe_payment_intent_id: "stripe:dispute:dp_mixed:4000:reinstated",
      metadata: {
        payment_intent_id: "pi_mixed_provenance",
        source: "charge.dispute.funds_reinstated",
        reference: "dispute dp_mixed",
        clawback_key: "stripe:dispute:dp_mixed:4000",
      },
      created_at: new Date("2026-08-20T11:00:00.000Z"),
    });

    const rows = await paymentHistoryService.listPaymentStates(organizationId);
    const row = rows.find((r) => r.id === `payment_request:${request.id}`);
    expect(row).toBeDefined();
    expect(row?.paymentState).toBe("dispute_reinstated");
    expect(row?.reinstatedCredits).toBe(40);
    // Either spelling reaches the dispute's debt: overturned, 0 not 40.
    expect(row?.unrecoveredShortfallCredits).toBe(0);
  });
});

describe("listPaymentStates — lossless traversal beyond the former route depth cap (#26752 P1)", () => {
  test("a 10,051-row history walks every page past the former 10,000 boundary exactly once", async () => {
    // The list route formerly rejected every offset above 10,000, so a card
    // that had appended 10,050 rows received hasMore=true and then a
    // permanent 400 on ?offset=10050 — the tail row was unreachable and the
    // retry loop could not step past the boundary. The service contract is
    // lossless: this test walks the FULL history at the route's default page
    // size across the former boundary and asserts every row is visited
    // exactly once (no skips, no duplicates), the boundary page itself is a
    // normal page, and the final partial page ends traversal cleanly.
    const seeds: Array<Promise<unknown>> = [];
    // 10,050 payment requests + 1 checkout order = 10,051 authorities. The
    // single order is created FIRST so it lands at the very BACK of the
    // (created_at DESC) merged ordering — the exact row the former cap
    // stranded.
    seeds.push(
      insertCheckoutOrder({
        organizationId,
        userId,
        amountCents: 300,
        status: "quoted",
        // Pinned old creation time: 10k bulk inserts race on now(), so
        // insertion order alone cannot guarantee this row is the oldest
        // authority. An explicit 2020 timestamp makes it deterministically
        // the very BACK of the (created_at DESC) merged ordering — the exact
        // row the former cap stranded.
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      }),
    );
    for (let i = 0; i < 10_050; i++) {
      seeds.push(
        insertStripePaymentRequest({
          organizationId,
          amountCents: 100,
          status: "pending",
          settlementTxRef: `pi_deep_${i}`,
        }),
      );
    }
    await Promise.all(seeds);

    const total = await paymentHistoryService.countPaymentStates(organizationId);
    expect(total).toBe(10_051);

    // Full walk at the route's default page size (50): 201 pages, the last
    // one partial. Every id seen exactly once across the former 10,000
    // boundary (pages 201..202 overlap offsets 10,000 and 10,050).
    const seen = new Set<string>();
    let pages = 0;
    let lastPageSize = -1;
    for (let offset = 0; offset < total; offset += 50) {
      const page = await paymentHistoryService.listPaymentStates(organizationId, 50, offset);
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThanOrEqual(50);
      for (const row of page) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      lastPageSize = page.length;
      pages++;
    }
    expect(pages).toBe(202); // 201 full pages + 1 partial page of 1 row
    expect(lastPageSize).toBe(1);
    expect(seen.size).toBe(10_051);

    // The stranded-tail row is the oldest authority (the checkout order
    // created first) and is on the FINAL page, reachable past the boundary.
    const finalPage = await paymentHistoryService.listPaymentStates(organizationId, 50, 10_050);
    expect(finalPage).toHaveLength(1);
    expect(finalPage[0]?.amountCents).toBe(300);
    expect(seen.has(finalPage[0]?.id as string)).toBe(true);
    // ...and its stable-id detail lookup resolves the same row the list walk
    // delivered (discoverability and detail agree past the boundary).
    const detail = await paymentHistoryService.findPaymentStateById(
      organizationId,
      finalPage[0]?.id as string,
    );
    expect(detail?.amountCents).toBe(300);
  }, 120_000);
});
