/**
 * #9321 — auto-top-up must PERSIST the credits it just charged for, and it must
 * dedup against the async Stripe webhook so the org is credited exactly once.
 *
 * The existing auto-top-up.test.ts mocks creditsService.addCredits at the seam to
 * prove the right args are passed. This file goes one layer deeper: it runs the
 * REAL creditsService.addCredits (the shared persistence path) over an in-memory
 * ledger that mirrors the production idempotency contract — the app-level
 * pre-check (findByStripePaymentIntent) and the atomic CTE that only inserts when
 * no row exists for that payment-intent id. That lets us assert the two things the
 * fix actually has to guarantee:
 *   (a) a successful auto-top-up writes a ledger row + bumps the org balance, and
 *   (b) the webhook replaying the SAME payment-intent id does not double-credit.
 * Only the boundaries are mocked (Stripe, the DB executor, repositories, cache).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory ledger shared by the repository fake and the SQL-executor fake.
// ---------------------------------------------------------------------------
interface LedgerRow {
  id: string;
  organization_id: string;
  amount: string;
  type: string;
  description: string;
  metadata: unknown;
  stripe_payment_intent_id: string | null;
  created_at: Date;
  user_id: string | null;
}

const ORG_ID = "org-1";
const ledger: LedgerRow[] = [];
const org = { id: ORG_ID, credit_balance: "5.00" };
let txSeq = 0;

function resetLedger() {
  ledger.length = 0;
  org.credit_balance = "5.00";
  txSeq = 0;
}

// ---------------------------------------------------------------------------
// DB boundary: sqlRows runs the real addCredits CTE. We emulate just the
// idempotency-relevant behavior: insert a row + bump balance ONLY when no row
// already exists for this payment-intent id; otherwise insert nothing.
// ---------------------------------------------------------------------------
const sqlRows = mock(async (_db: unknown, query: { queryChunks?: unknown[] }) => {
  // drizzle's sql`` interleaves StringChunk objects (the SQL fragments) with the
  // bound params, which sit in queryChunks as bare primitives. Keep only the
  // primitives — those are the values the real query would bind.
  const params = (query.queryChunks ?? []).filter(
    (chunk) => typeof chunk === "string" || typeof chunk === "number",
  );

  const organizationId = params.find((v) => v === ORG_ID) as string | undefined;
  const stripeId =
    (params.find((v) => typeof v === "string" && (v as string).startsWith("pi_")) as
      | string
      | undefined) ?? null;
  const amountStr = params.find(
    (v) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v as string),
  ) as string | undefined;
  const amount = Number(amountStr ?? "0");

  if (organizationId !== ORG_ID) {
    return [{ org_exists: false }];
  }

  const current = Number(org.credit_balance);
  const alreadyExists =
    stripeId !== null && ledger.some((r) => r.stripe_payment_intent_id === stripeId);

  if (alreadyExists) {
    // CTE inserts nothing; balance unchanged; no `inserted` row returned.
    return [
      {
        org_exists: true,
        current_balance: current,
        new_balance: current,
        id: null,
      },
    ];
  }

  const newBalance = current + amount;
  org.credit_balance = newBalance.toFixed(2);
  txSeq += 1;
  const row: LedgerRow = {
    id: `tx-${txSeq}`,
    organization_id: ORG_ID,
    amount: amount.toFixed(2),
    type: "credit",
    description: "Auto top-up",
    metadata: {},
    stripe_payment_intent_id: stripeId,
    created_at: new Date(),
    user_id: null,
  };
  ledger.push(row);

  return [
    {
      org_exists: true,
      current_balance: current,
      new_balance: newBalance,
      ...row,
    },
  ];
});

mock.module("../../../db/execute-helpers", () => ({
  sqlRows,
}));

const dbReadStub = {
  select: mock(() => ({ from: mock(() => ({ where: mock(async () => []) })) })),
};
mock.module("../../../db/helpers", () => ({
  dbWrite: {},
  dbRead: dbReadStub,
  db: {},
  getDbConnectionInfo: mock(() => ({})),
}));

// Repositories — the app-level idempotency pre-check + balance reads come through here.
const findByStripePaymentIntent = mock(async (paymentIntentId: string) =>
  ledger.find((r) => r.stripe_payment_intent_id === paymentIntentId),
);
const findOrgById = mock(async (id: string) => (id === ORG_ID ? { ...org } : undefined));
const listByOrganization = mock(async () => [{ id: "user-1", email: "billing@example.com" }]);
const updateOrganization = mock(async () => undefined);

// Mock the repositories barrel directly (not the leaf modules) so the real
// db/client → plugin-sql → @elizaos/core chain is never pulled in. Provide the
// full set of repos the credits import graph touches.
mock.module("../../../db/repositories", () => ({
  creditTransactionsRepository: {
    findByStripePaymentIntent,
  },
  organizationsRepository: {
    findById: findOrgById,
    update: updateOrganization,
  },
  usersRepository: {
    listByOrganization,
  },
  userSessionsRepository: {},
  creditPacksRepository: {},
}));

// dbRead is only used by the auto-top-up cron query, which we don't drive here.
mock.module("../../../db/client", () => ({
  dbRead: {
    select: mock(() => ({
      from: mock(() => ({ where: mock(async () => []) })),
    })),
  },
}));

// Stripe boundary.
const createPaymentIntent = mock(async () => ({
  id: "pi_auto_123",
  status: "succeeded",
}));
const retrievePaymentMethod = mock(async () => ({
  card: { brand: "visa", last4: "4242" },
}));
mock.module("../../stripe", () => ({
  requireStripe: mock(() => ({
    paymentIntents: { create: createPaymentIntent },
    paymentMethods: { retrieve: retrievePaymentMethod },
  })),
}));

// No affiliate markup for these cases (keep base == total).
mock.module("../affiliates", () => ({
  affiliatesService: { getReferrer: mock(async () => null) },
}));

mock.module("../email", () => ({
  emailService: {
    sendAutoTopUpSuccessEmail: mock(async () => true),
    sendAutoTopUpDisabledEmail: mock(async () => true),
  },
}));

// Cache + side-channel no-ops so the real addCredits path doesn't reach for infra.
mock.module("../../cache/invalidation", () => ({
  CacheInvalidation: { onCreditMutation: mock(async () => undefined) },
}));
mock.module("../../cache/organizations-cache", () => ({
  invalidateOrganizationCache: mock(async () => undefined),
}));

mock.module("../../utils/logger", () => ({
  logger: { debug: mock(), error: mock(), info: mock(), warn: mock() },
}));

const { AutoTopUpService } = await import("../auto-top-up");
const { creditsService } = await import("../credits");

type AutoTopUpOrganization = Parameters<AutoTopUpService["executeAutoTopUp"]>[0];

function makeOrganization(): AutoTopUpOrganization {
  return {
    id: ORG_ID,
    name: "Acme Cloud",
    credit_balance: org.credit_balance,
    auto_top_up_threshold: "10.00",
    auto_top_up_amount: "10.00",
    stripe_customer_id: "cus_123",
    stripe_default_payment_method: "pm_123",
    billing_email: "billing@example.com",
    auto_top_up_enabled: true,
  } as AutoTopUpOrganization;
}

beforeEach(() => {
  resetLedger();
  sqlRows.mockClear();
  findByStripePaymentIntent.mockClear();
  findOrgById.mockClear();
  createPaymentIntent.mockClear();
});

describe("auto-top-up persistence + webhook idempotency (#9321, real credit logic)", () => {
  test("a successful auto-top-up writes one ledger row and bumps the org balance", async () => {
    const result = await new AutoTopUpService().executeAutoTopUp(makeOrganization());

    // Real persistence happened: exactly one ledger row keyed on the payment intent.
    expect(ledger).toHaveLength(1);
    expect(ledger[0].stripe_payment_intent_id).toBe("pi_auto_123");
    expect(Number(ledger[0].amount)).toBe(10);

    // Org balance moved 5 → 15 in the store, and the returned balance is DB-derived.
    expect(Number(org.credit_balance)).toBe(15);
    expect(result).toEqual({
      organizationId: ORG_ID,
      success: true,
      amount: 10,
      newBalance: 15,
    });
  });

  test("the webhook replaying the same payment-intent id does not double-credit", async () => {
    // Sync path (auto-top-up) credits first.
    await new AutoTopUpService().executeAutoTopUp(makeOrganization());
    expect(ledger).toHaveLength(1);
    expect(Number(org.credit_balance)).toBe(15);

    // Now the async Stripe webhook fires with the SAME payment intent + same base credits.
    const replay = await creditsService.addCredits({
      organizationId: ORG_ID,
      amount: 10,
      description: "Webhook credit",
      stripePaymentIntentId: "pi_auto_123",
    });

    // No second ledger row, balance unchanged — exactly one credit, order-independent.
    expect(ledger).toHaveLength(1);
    expect(Number(org.credit_balance)).toBe(15);
    expect(replay.newBalance).toBe(15);
    expect(replay.transaction.id).toBe("tx-1"); // the pre-existing row, not a new one
  });
});
