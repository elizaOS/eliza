/**
 * Proves allowance-first and cash-only funding reservations against real
 * PGlite rows, including exact replay and transaction rollback on shortfall.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import {
  closeDatabaseConnectionsForTests,
  dbWrite,
  getPgliteClientForTests,
} from "../../db/client";
import { billingFundingReservations } from "../../db/schemas/billing-funding-reservations";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../../db/schemas/billing-subscriptions";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { organizations } from "../../db/schemas/organizations";
import { subscriptionAllowancePeriods } from "../../db/schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../../db/schemas/subscription-allowance-transactions";
import { creditsService } from "./credits";
import {
  SUBSCRIPTION_FUNDING_INSUFFICIENT,
  SUBSCRIPTION_FUNDING_RELEASE_NOT_DUE,
  SubscriptionFundingService,
} from "./subscription-funding";

const autoTopUpCalls: string[] = [];
const subscriptionFundingService = new SubscriptionFundingService(async (organizationId) => {
  autoTopUpCalls.push(organizationId);
});

const PGLITE_TIMEOUT = 90_000;
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const SUBSCRIPTION_ID = "20000000-0000-4000-8000-000000000002";
const PERIOD_ID = "30000000-0000-4000-8000-000000000003";
const PERIOD_START = new Date("2026-08-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-09-01T00:00:00.000Z");
const NOW = new Date("2026-08-20T12:00:00.000Z");

let pgliteReady = true;
let schemaFailure = "";

async function seedBillingState(): Promise<void> {
  await getPgliteClientForTests().exec(`
    INSERT INTO organizations (id, name, slug, credit_balance)
    VALUES ('${ORGANIZATION_ID}', 'Subscription funding test', 'subscription-funding-test', 10.000000)
  `);
  await dbWrite.insert(billingSubscriptions).values({
    id: SUBSCRIPTION_ID,
    organization_id: ORGANIZATION_ID,
    stripe_subscription_id: "sub_fundingtest",
    stripe_subscription_item_id: "si_fundingtest",
    plan_key: "plus_monthly",
    catalog_version: "v1",
    status: "active",
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    lifecycle_revision: 1,
    provider_object_version: 1,
    provider_object_digest: "a".repeat(64),
  });
  await dbWrite.insert(billingSubscriptionRevisions).values({
    organization_id: ORGANIZATION_ID,
    subscription_id: SUBSCRIPTION_ID,
    revision: 1,
    source: "webhook",
    stripe_subscription_id: "sub_fundingtest",
    stripe_subscription_item_id: "si_fundingtest",
    plan_key: "plus_monthly",
    catalog_version: "v1",
    status: "active",
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    cancel_at_period_end: false,
    provider_object_version: 1,
    provider_object_digest: "a".repeat(64),
  });
  await dbWrite.insert(subscriptionAllowancePeriods).values({
    id: PERIOD_ID,
    organization_id: ORGANIZATION_ID,
    subscription_id: SUBSCRIPTION_ID,
    subscription_revision: 1,
    stripe_invoice_id: "in_fundingtest",
    plan_key: "plus_monthly",
    catalog_version: "v1",
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    expires_at: PERIOD_END,
    granted_amount: "6.000000",
    remaining_amount: "6.000000",
  });
  await dbWrite.insert(subscriptionAllowanceTransactions).values({
    organization_id: ORGANIZATION_ID,
    allowance_period_id: PERIOD_ID,
    sequence: 1,
    kind: "grant",
    amount: "6.000000",
    remaining_before: "0.000000",
    remaining_after: "6.000000",
    expired_before: "0.000000",
    expired_after: "0.000000",
    clawed_back_before: "0.000000",
    clawed_back_after: "0.000000",
    idempotency_key: "funding.test.grant",
  });
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    schemaFailure = "isolated PGlite is required";
    return;
  }
  try {
    await getPgliteClientForTests().exec(`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE,
        credit_balance numeric(16,6) NOT NULL DEFAULT 0, spendable_revision bigint NOT NULL DEFAULT 0,
        settings jsonb DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
        user_id uuid, amount numeric(16,6) NOT NULL, type text NOT NULL, description text,
        metadata jsonb NOT NULL DEFAULT '{}', stripe_payment_intent_id text UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
        UNIQUE (id, organization_id)
      );
      CREATE TABLE billing_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
        stripe_subscription_id text NOT NULL UNIQUE, stripe_subscription_item_id text NOT NULL UNIQUE,
        plan_key text NOT NULL, catalog_version text NOT NULL, status text NOT NULL,
        current_period_start timestamptz NOT NULL, current_period_end timestamptz NOT NULL,
        cancel_at_period_end boolean NOT NULL DEFAULT false, canceled_at timestamptz, ended_at timestamptz,
        dunning_started_at timestamptz, grace_expires_at timestamptz, pending_plan_key text,
        lifecycle_revision bigint NOT NULL, provider_object_version bigint NOT NULL,
        provider_event_id text, provider_event_created_at timestamptz, provider_object_digest text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (id, organization_id)
      );
      CREATE TABLE billing_subscription_revisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
        subscription_id uuid NOT NULL, revision bigint NOT NULL, source text NOT NULL,
        stripe_subscription_id text NOT NULL, stripe_subscription_item_id text NOT NULL,
        plan_key text NOT NULL, catalog_version text NOT NULL, status text NOT NULL,
        current_period_start timestamptz NOT NULL, current_period_end timestamptz NOT NULL,
        cancel_at_period_end boolean NOT NULL, canceled_at timestamptz, ended_at timestamptz,
        dunning_started_at timestamptz, grace_expires_at timestamptz, pending_plan_key text,
        provider_object_version bigint NOT NULL, provider_event_id text, provider_event_created_at timestamptz,
        provider_object_digest text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (subscription_id, organization_id, revision)
      );
      CREATE TABLE subscription_allowance_periods (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
        subscription_id uuid NOT NULL, subscription_revision bigint NOT NULL, stripe_invoice_id text NOT NULL UNIQUE,
        plan_key text NOT NULL, catalog_version text NOT NULL, period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL, expires_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'open',
        granted_amount numeric(16,6) NOT NULL, remaining_amount numeric(16,6) NOT NULL,
        expired_amount numeric(16,6) NOT NULL DEFAULT 0, clawed_back_amount numeric(16,6) NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (id, organization_id)
      );
      CREATE TABLE billing_funding_reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
        logical_operation_id text NOT NULL, reservation_phase text NOT NULL DEFAULT 'initial',
        phase_sequence integer NOT NULL DEFAULT 0, parent_reservation_id uuid, root_reservation_id uuid,
        funding_class text NOT NULL, requested_amount numeric(16,6) NOT NULL,
        allowance_amount numeric(16,6) NOT NULL, purchased_credit_amount numeric(16,6) NOT NULL,
        allowance_period_id uuid, settled_allowance_amount numeric(16,6) NOT NULL DEFAULT 0,
        settled_purchased_credit_amount numeric(16,6) NOT NULL DEFAULT 0,
        refunded_allowance_amount numeric(16,6) NOT NULL DEFAULT 0,
        refunded_purchased_credit_amount numeric(16,6) NOT NULL DEFAULT 0,
        purchased_credit_reservation_transaction_id uuid,
        purchased_credit_settlement_transaction_id uuid, purchased_credit_refund_transaction_id uuid,
        status text NOT NULL DEFAULT 'reserved', expires_at timestamptz NOT NULL, settled_at timestamptz,
        closed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, logical_operation_id),
        UNIQUE (id, organization_id)
      );
      CREATE TABLE subscription_allowance_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        allowance_period_id uuid NOT NULL, funding_reservation_id uuid,
        source_subscription_id uuid, source_subscription_revision bigint, source_invoice_id text,
        source_plan_key text, source_catalog_version text, sequence integer NOT NULL, kind text NOT NULL,
        amount numeric(16,6) NOT NULL, remaining_before numeric(16,6) NOT NULL,
        remaining_after numeric(16,6) NOT NULL, expired_before numeric(16,6) NOT NULL,
        expired_after numeric(16,6) NOT NULL, clawed_back_before numeric(16,6) NOT NULL,
        clawed_back_after numeric(16,6) NOT NULL, idempotency_key text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (organization_id, idempotency_key),
        UNIQUE (allowance_period_id, sequence)
      );
      CREATE TABLE affiliate_payout_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id text NOT NULL UNIQUE,
        affiliate_code_id uuid NOT NULL, affiliate_user_id uuid NOT NULL,
        amount numeric(16,4) NOT NULL, description text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}', attempts integer NOT NULL DEFAULT 0,
        processed_at timestamptz, ledger_entry_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  } catch (error) {
    // error-policy:J4 Test setup failure stays visibly distinct from passing coverage.
    schemaFailure = error instanceof Error ? error.message : String(error);
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  expect(pgliteReady).toBe(true);
  await getPgliteClientForTests().exec("DELETE FROM affiliate_payout_outbox");
  await dbWrite.delete(subscriptionAllowanceTransactions);
  await dbWrite.delete(billingFundingReservations);
  await dbWrite.delete(subscriptionAllowancePeriods);
  await dbWrite.delete(billingSubscriptionRevisions);
  await dbWrite.delete(billingSubscriptions);
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(organizations);
  await seedBillingState();
  autoTopUpCalls.length = 0;
  spyOn(creditsService, "invalidateCreditCaches").mockResolvedValue();
  spyOn(creditsService, "notifyBalanceDecrease").mockResolvedValue();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("SubscriptionFundingService.reserve (real PGlite)", () => {
  test("consumes allowance first, purchases only the remainder, and replays exactly", async () => {
    const input = {
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.mixed.0001",
      operation: "ai_inference" as const,
      amount: "8.000000",
      description: "mixed metered usage",
      occurredAt: NOW,
      expiresAt: new Date("2026-08-20T13:00:00.000Z"),
    };
    const first = await subscriptionFundingService.reserve(input);
    const replay = await subscriptionFundingService.reserve(input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(first.reservation.allowance_amount).toBe("6.000000");
    expect(first.reservation.purchased_credit_amount).toBe("2.000000");
    expect(first.reservation.allowance_period_id).toBe(PERIOD_ID);

    const [organization] = await dbWrite
      .select({ balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, ORGANIZATION_ID));
    const [period] = await dbWrite
      .select({ remaining: subscriptionAllowancePeriods.remaining_amount })
      .from(subscriptionAllowancePeriods)
      .where(eq(subscriptionAllowancePeriods.id, PERIOD_ID));
    const reservations = await dbWrite
      .select()
      .from(billingFundingReservations)
      .where(eq(billingFundingReservations.organization_id, ORGANIZATION_ID));
    const reserveLedger = await dbWrite
      .select()
      .from(subscriptionAllowanceTransactions)
      .where(
        and(
          eq(subscriptionAllowanceTransactions.allowance_period_id, PERIOD_ID),
          eq(subscriptionAllowanceTransactions.kind, "reserve"),
        ),
      );
    expect(organization?.balance).toBe("8.000000");
    expect(period?.remaining).toBe("0.000000");
    expect(reservations).toHaveLength(1);
    expect(reserveLedger).toHaveLength(1);
    expect(reserveLedger[0]?.funding_reservation_id).toBe(first.reservation.id);
  });

  test("database-clock TTL reservations replay with their original expiry", async () => {
    const input = {
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "inference-gate:req-ttl-0001",
      operation: "ai_inference" as const,
      amount: "1.000000",
      description: "retry-stable inference hold",
      reservationTtlMs: 7_200_000,
    };

    const first = await subscriptionFundingService.reserve(input);
    const replay = await subscriptionFundingService.reserve(input);

    expect(replay.replayed).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(first.reservation.expires_at.getTime() - first.reservation.created_at.getTime()).toBe(
      7_200_000,
    );
  });

  test("cash-only ignores available allowance", async () => {
    const result = await subscriptionFundingService.reserve({
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.cashonly.0001",
      operation: "domain",
      amount: "4.000000",
      description: "domain purchase",
      occurredAt: NOW,
      expiresAt: new Date("2026-08-20T13:00:00.000Z"),
    });
    expect(result.reservation.allowance_amount).toBe("0.000000");
    expect(result.reservation.purchased_credit_amount).toBe("4.000000");
    const [period] = await dbWrite
      .select({ remaining: subscriptionAllowancePeriods.remaining_amount })
      .from(subscriptionAllowancePeriods)
      .where(eq(subscriptionAllowancePeriods.id, PERIOD_ID));
    expect(period?.remaining).toBe("6.000000");
  });

  test("rolls back allowance when purchased credits cannot cover the remainder", async () => {
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "1.000000" })
      .where(eq(organizations.id, ORGANIZATION_ID));
    try {
      await subscriptionFundingService.reserve({
        organizationId: ORGANIZATION_ID,
        logicalOperationId: "usage.shortfall.0001",
        operation: "ai_inference",
        amount: "8.000000",
        description: "too expensive",
        occurredAt: NOW,
        expiresAt: new Date("2026-08-20T13:00:00.000Z"),
      });
      throw new Error("expected insufficient funding");
    } catch (error) {
      expect(error).toMatchObject({ code: SUBSCRIPTION_FUNDING_INSUFFICIENT });
    }
    const [period] = await dbWrite
      .select({ remaining: subscriptionAllowancePeriods.remaining_amount })
      .from(subscriptionAllowancePeriods)
      .where(eq(subscriptionAllowancePeriods.id, PERIOD_ID));
    const reservations = await dbWrite.select().from(billingFundingReservations);
    expect(period?.remaining).toBe("6.000000");
    expect(reservations).toHaveLength(0);
    expect(autoTopUpCalls).toEqual([ORGANIZATION_ID]);

    await expect(
      subscriptionFundingService.reserve({
        organizationId: ORGANIZATION_ID,
        logicalOperationId: "usage.cashshort.0001",
        operation: "domain",
        amount: "2.000000",
        description: "cash-only shortfall",
        occurredAt: NOW,
        expiresAt: new Date("2026-08-20T13:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: SUBSCRIPTION_FUNDING_INSUFFICIENT });
    expect(autoTopUpCalls).toEqual([ORGANIZATION_ID, ORGANIZATION_ID]);
  });

  test("settles a full hold and returns unused value to each original source exactly once", async () => {
    const reserveInput = {
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.settle.0001",
      operation: "ai_inference" as const,
      amount: "8.000000",
      description: "estimated usage",
      occurredAt: NOW,
      expiresAt: new Date("2026-08-20T13:00:00.000Z"),
    };
    await subscriptionFundingService.reserve(reserveInput);
    const settlementInput = {
      organizationId: ORGANIZATION_ID,
      logicalOperationId: reserveInput.logicalOperationId,
      operation: "ai_inference" as const,
      actualAmount: "3.000000",
      occurredAt: new Date("2026-08-20T12:05:00.000Z"),
    };
    const settled = await subscriptionFundingService.settle(settlementInput);
    const replay = await subscriptionFundingService.settle(settlementInput);

    expect(settled.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(settled.reservation.status).toBe("partially_refunded");
    expect(settled.reservation.settled_allowance_amount).toBe("6.000000");
    expect(settled.reservation.settled_purchased_credit_amount).toBe("2.000000");
    expect(settled.reservation.refunded_allowance_amount).toBe("3.000000");
    expect(settled.reservation.refunded_purchased_credit_amount).toBe("2.000000");

    const [organization] = await dbWrite
      .select({ balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, ORGANIZATION_ID));
    const [period] = await dbWrite
      .select({ remaining: subscriptionAllowancePeriods.remaining_amount })
      .from(subscriptionAllowancePeriods)
      .where(eq(subscriptionAllowancePeriods.id, PERIOD_ID));
    const ledger = await dbWrite
      .select({ kind: subscriptionAllowanceTransactions.kind })
      .from(subscriptionAllowanceTransactions)
      .where(eq(subscriptionAllowanceTransactions.funding_reservation_id, settled.reservation.id));
    expect(organization?.balance).toBe("10.000000");
    expect(period?.remaining).toBe("3.000000");
    expect(ledger.map((row) => row.kind)).toEqual(["reserve", "settle", "refund"]);
  });

  test("settlement atomically enqueues one exact affiliate payout", async () => {
    const logicalOperationId = "inference-gate:req-affiliate-0001";
    const metadata = {
      affiliatePayout: {
        version: 1 as const,
        sourceId: "ai_billing:affiliate:req-affiliate-0001",
        attribution: {
          affiliateCodeId: "40000000-0000-4000-8000-000000000004",
          affiliateUserId: "50000000-0000-4000-8000-000000000005",
          affiliateCode: "PARTNER",
          markupPercent: 0.2,
        },
        model: "test-model",
      },
    };
    const reserved = await subscriptionFundingService.reserve({
      organizationId: ORGANIZATION_ID,
      logicalOperationId,
      operation: "ai_inference",
      amount: "1.500000",
      description: "affiliate inference",
      reservationTtlMs: 7_200_000,
      metadata,
    });
    const settlement = {
      organizationId: ORGANIZATION_ID,
      logicalOperationId,
      operation: "ai_inference" as const,
      actualAmount: "1.200000",
      occurredAt: reserved.reservation.created_at,
      metadata,
    };

    await subscriptionFundingService.settle(settlement);
    await subscriptionFundingService.settle(settlement);

    const rows = await getPgliteClientForTests().query<{
      source_id: string;
      amount: string;
    }>("SELECT source_id, amount::text AS amount FROM affiliate_payout_outbox");
    expect(rows.rows).toEqual([
      {
        source_id: "ai_billing:affiliate:req-affiliate-0001",
        amount: "0.2000",
      },
    ]);
  });

  test("reserves and settles an allowance-first linked overage leg exactly once", async () => {
    await subscriptionFundingService.reserve({
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.overage.0001",
      operation: "ai_inference",
      amount: "2.000000",
      description: "under-estimated usage",
      occurredAt: NOW,
      expiresAt: new Date("2026-08-20T13:00:00.000Z"),
    });
    const settlement = {
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.overage.0001",
      operation: "ai_inference" as const,
      actualAmount: "2.500000",
      occurredAt: new Date("2026-08-20T12:05:00.000Z"),
    };
    const first = await subscriptionFundingService.settle(settlement);
    const replay = await subscriptionFundingService.settle(settlement);
    expect(first.overageReservation).toMatchObject({
      reservation_phase: "overage",
      phase_sequence: 1,
      root_reservation_id: first.reservation.id,
      parent_reservation_id: first.reservation.id,
      allowance_amount: "0.500000",
      purchased_credit_amount: "0.000000",
      status: "settled",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.overageReservation?.id).toBe(first.overageReservation?.id);
    const [period] = await dbWrite
      .select({ remaining: subscriptionAllowancePeriods.remaining_amount })
      .from(subscriptionAllowancePeriods)
      .where(eq(subscriptionAllowancePeriods.id, PERIOD_ID));
    expect(period?.remaining).toBe("3.500000");
  });

  test("releases canceled mixed-source holds and replays the terminal release", async () => {
    await subscriptionFundingService.reserve({
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.cancel.0001",
      operation: "ai_inference",
      amount: "8.000000",
      description: "crashed provider hold",
      occurredAt: NOW,
      expiresAt: new Date("2026-08-20T13:00:00.000Z"),
    });
    const first = await subscriptionFundingService.releaseCanceled({
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.cancel.0001",
    });
    const replay = await subscriptionFundingService.releaseCanceled({
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.cancel.0001",
    });
    expect(first.reservation.status).toBe("refunded");
    expect(first.reservation.refunded_allowance_amount).toBe("6.000000");
    expect(first.reservation.refunded_purchased_credit_amount).toBe("2.000000");
    expect(replay.replayed).toBe(true);
    const [organization] = await dbWrite
      .select({ balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, ORGANIZATION_ID));
    expect(organization?.balance).toBe("10.000000");
  });

  test("releaseExpired uses the locked database clock and rejects an early sweep", async () => {
    await subscriptionFundingService.reserve({
      organizationId: ORGANIZATION_ID,
      logicalOperationId: "usage.expiry.0001",
      operation: "ai_inference",
      amount: "2.000000",
      description: "active hold",
      occurredAt: NOW,
      expiresAt: new Date("2099-08-20T13:00:00.000Z"),
    });
    await expect(
      subscriptionFundingService.releaseExpired({
        organizationId: ORGANIZATION_ID,
        logicalOperationId: "usage.expiry.0001",
      }),
    ).rejects.toMatchObject({ code: SUBSCRIPTION_FUNDING_RELEASE_NOT_DUE });
  });

  test("releaseExpired keeps a late allowance refund in the expired audit bucket", async () => {
    const logicalOperationId = "usage.expired.0001";
    const reserved = await subscriptionFundingService.reserve({
      organizationId: ORGANIZATION_ID,
      logicalOperationId,
      operation: "ai_inference",
      amount: "2.000000",
      description: "stranded hold",
      occurredAt: NOW,
      expiresAt: new Date("2026-08-20T13:00:00.000Z"),
    });
    const expiredAt = new Date("2026-08-19T12:00:00.000Z");
    await dbWrite
      .update(billingFundingReservations)
      .set({ expires_at: expiredAt })
      .where(eq(billingFundingReservations.id, reserved.reservation.id));
    await dbWrite
      .update(subscriptionAllowancePeriods)
      .set({ expires_at: expiredAt })
      .where(eq(subscriptionAllowancePeriods.id, PERIOD_ID));

    const released = await subscriptionFundingService.releaseExpired({
      organizationId: ORGANIZATION_ID,
      logicalOperationId,
    });
    const replay = await subscriptionFundingService.releaseExpired({
      organizationId: ORGANIZATION_ID,
      logicalOperationId,
    });
    expect(released.reservation.status).toBe("refunded");
    expect(replay.replayed).toBe(true);
    const [period] = await dbWrite
      .select({
        remaining: subscriptionAllowancePeriods.remaining_amount,
        expired: subscriptionAllowancePeriods.expired_amount,
      })
      .from(subscriptionAllowancePeriods)
      .where(eq(subscriptionAllowancePeriods.id, PERIOD_ID));
    expect(period).toEqual({ remaining: "4.000000", expired: "2.000000" });
  });
});
