/**
 * Exercises subscription operation repositories against real PGlite, including exact replay,
 * tenant isolation, lease takeover, provider ambiguity, receipt application, and fence CAS.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_A = "51000000-0000-4000-8000-000000000001";
const ORG_B = "51000000-0000-4000-8000-000000000002";
const USER = "52000000-0000-4000-8000-000000000001";
const SUB_A = "53000000-0000-4000-8000-000000000001";
const SUB_B = "53000000-0000-4000-8000-000000000002";
const CHECKOUT_SUB = "53000000-0000-4000-8000-000000000003";
const COMMAND = "54000000-0000-4000-8000-000000000001";
const RECEIPT = "55000000-0000-4000-8000-000000000001";
const INCIDENT = "56000000-0000-4000-8000-000000000001";
const PERIOD = "57000000-0000-4000-8000-000000000001";
const EXPIRED_PERIOD = "57000000-0000-4000-8000-000000000002";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const BASE = Date.parse("2026-08-20T12:00:00.000Z");

setDefaultTimeout(120_000);

let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: import("./subscription-billing-operations").SubscriptionBillingOperationsRepository;
let authority: import("./subscription-authority").SubscriptionAuthorityRepository;
let allowance: import("./subscription-allowance").SubscriptionAllowanceRepository;
let entitlements: import("./subscription-entitlements").SubscriptionEntitlementsRepository;
let writeTransaction: typeof import("../helpers").writeTransaction;
let microsToMoney: typeof import("./subscription-funding-reservations").microsToMoney;

function at(offset: number): Date {
  return new Date(BASE + offset);
}

async function applyMigration(name: string): Promise<void> {
  const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
}

async function enqueue(
  overrides: Partial<
    import("./subscription-billing-operations").EnqueueSubscriptionCommandInput
  > = {},
) {
  return repository.enqueueCommand({
    id: COMMAND,
    organizationId: ORG_A,
    subscriptionId: SUB_A,
    requestedByUserId: USER,
    kind: "upgrade",
    targetPlanKey: "pro_monthly",
    expectedSubscriptionRevision: 1,
    idempotencyKey: "command:exact-one",
    providerIdempotencyKey: "provider-command-exact-one",
    requestDigest: DIGEST_A,
    now: at(0),
    ...overrides,
  });
}

async function recordEvent(
  overrides: Partial<import("./subscription-billing-operations").RecordSubscriptionEventInput> = {},
) {
  return repository.recordEvent({
    id: RECEIPT,
    organizationId: ORG_A,
    subscriptionId: SUB_A,
    providerEventId: "event_exact1",
    eventType: "invoice.paid",
    providerObjectType: "invoice",
    providerObjectId: "invoice_exact1",
    livemode: false,
    eventCreatedAt: at(0),
    payloadDigest: DIGEST_A,
    now: at(1),
    ...overrides,
  });
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import("../client"));
  ({ subscriptionBillingOperationsRepository: repository } = await import(
    "./subscription-billing-operations"
  ));
  ({ subscriptionAuthorityRepository: authority } = await import("./subscription-authority"));
  ({ subscriptionAllowanceRepository: allowance } = await import("./subscription-allowance"));
  ({ subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  ));
  ({ writeTransaction } = await import("../helpers"));
  ({ microsToMoney } = await import("./subscription-funding-reservations"));
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      account_lifecycle_state text NOT NULL DEFAULT 'active',
      paid_work_fenced_at timestamptz,
      stripe_customer_id text
    );
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id)
    );
  `);
  await applyMigration("0373_subscription_authority.sql");
});

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    ALTER TABLE billing_subscription_revisions DISABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions DISABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    TRUNCATE TABLE billing_subscriptions, users, organizations CASCADE;
    ALTER TABLE billing_subscription_revisions ENABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions ENABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users (id) VALUES ('${USER}');
    INSERT INTO billing_subscriptions (
      id, organization_id, provider_environment, stripe_customer_id,
      stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_digest
    ) VALUES
      ('${SUB_A}', '${ORG_A}', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, '${DIGEST_A}'),
      ('${SUB_B}', '${ORG_B}', 'test', 'cus_repob', 'sub_repob', 'si_repob', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, '${DIGEST_A}');
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, provider_environment,
      stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_digest
    ) VALUES ('${ORG_A}', '${SUB_A}', 1, 'webhook', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa',
      'plus_monthly', 'v1', 'active', '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z', false, '${DIGEST_A}');
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("SubscriptionBillingOperationsRepository", () => {
  test("accepts exact command replay and rejects digest or tenant divergence", async () => {
    expect((await enqueue()).replayed).toBe(false);
    expect((await enqueue()).replayed).toBe(true);
    await expect(enqueue({ requestDigest: DIGEST_B })).rejects.toMatchObject({
      code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
    });
    await expect(
      enqueue({
        id: randomUUID(),
        idempotencyKey: "command:other-one",
        providerIdempotencyKey: "provider-command-exact-one",
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT" });
    expect(await repository.findCommand(ORG_B, COMMAND)).toBeUndefined();
    await getPgliteClientForTests().exec(
      `UPDATE billing_subscriptions SET status='canceled' WHERE id='${SUB_A}'`,
    );
    const checkout = await enqueue({
      id: randomUUID(),
      subscriptionId: null,
      kind: "checkout",
      targetPlanKey: "plus_monthly",
      expectedSubscriptionRevision: null,
      idempotencyKey: "checkout:exact-one",
      providerIdempotencyKey: "provider-checkout-exact-one",
    });
    expect(checkout.value).toMatchObject({
      kind: "checkout",
      subscription_id: null,
      expected_subscription_revision: null,
    });
    const competingCheckout = {
      id: randomUUID(),
      subscriptionId: null,
      kind: "checkout",
      targetPlanKey: "pro_monthly",
      expectedSubscriptionRevision: null,
      idempotencyKey: "checkout:competing-two",
      providerIdempotencyKey: "provider-checkout-competing-two",
    } as const;
    await expect(enqueue(competingCheckout)).rejects.toMatchObject({
      code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
    });
    await repository.markCommandOutcomeUnknown({
      organizationId: ORG_A,
      commandId: checkout.value.id,
      expectedStateRevision: 1,
      expectedExecutionGeneration: 0,
    });
    await repository.resolveCommandOutcome({
      organizationId: ORG_A,
      commandId: checkout.value.id,
      expectedStateRevision: 2,
      expectedExecutionGeneration: 1,
      outcome: "SUCCEEDED",
      providerResponseDigest: DIGEST_B,
      errorCode: null,
    });
    await expect(enqueue(competingCheckout)).rejects.toMatchObject({
      code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
    });
    await getPgliteClientForTests().exec(`
      INSERT INTO billing_subscriptions (
        id, organization_id, provider_environment, stripe_customer_id,
        stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version,
        status, current_period_start, current_period_end, lifecycle_revision,
        provider_object_digest
      ) VALUES (
        '${CHECKOUT_SUB}', '${ORG_A}', 'test', 'cus_checkout', 'sub_checkout', 'si_checkout',
        'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z', 1, '${DIGEST_B}'
      );
      INSERT INTO billing_subscription_revisions (
        organization_id, subscription_id, revision, source, provider_environment,
        stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
        plan_key, catalog_version, status, current_period_start, current_period_end,
        cancel_at_period_end, provider_object_digest
      ) VALUES (
        '${ORG_A}', '${CHECKOUT_SUB}', 1, 'checkout', 'test', 'cus_checkout', 'sub_checkout',
        'si_checkout', 'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z',
        false, '${DIGEST_B}'
      );
      UPDATE billing_subscriptions
      SET plan_key='pro_monthly', provider_object_digest='${DIGEST_A}', lifecycle_revision=2
      WHERE id='${CHECKOUT_SUB}';
    `);
    expect(
      await repository.applyCheckoutResult({
        organizationId: ORG_A,
        commandId: checkout.value.id,
        resultSubscriptionId: CHECKOUT_SUB,
        expectedStateRevision: 3,
      }),
    ).toMatchObject({ status: "APPLIED", result_subscription_id: CHECKOUT_SUB });
    await expect(enqueue(competingCheckout)).rejects.toMatchObject({
      code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
    });
    await getPgliteClientForTests().exec(
      `UPDATE billing_subscriptions SET status='canceled' WHERE id='${CHECKOUT_SUB}'`,
    );
    expect((await enqueue(competingCheckout)).value.kind).toBe("checkout");
  });

  test("fences provider dispatch as outcome-unknown and resolves it with revision CAS", async () => {
    const prepared = (await enqueue()).value;
    const fenced = await repository.markCommandOutcomeUnknown({
      organizationId: ORG_A,
      commandId: COMMAND,
      expectedStateRevision: prepared.state_revision,
      expectedExecutionGeneration: prepared.execution_generation,
    });
    expect(fenced).toMatchObject({
      status: "OUTCOME_UNKNOWN",
      state_revision: 2,
      execution_generation: 1,
      provider_idempotency_key: "provider-command-exact-one",
    });
    expect(await repository.listCommandsNeedingRecovery(10)).toHaveLength(1);
    expect(
      await repository.markCommandOutcomeUnknown({
        organizationId: ORG_A,
        commandId: COMMAND,
        expectedStateRevision: 1,
        expectedExecutionGeneration: 0,
      }),
    ).toMatchObject({ status: "OUTCOME_UNKNOWN" });
    const resolution = {
      organizationId: ORG_A,
      commandId: COMMAND,
      expectedStateRevision: 2,
      expectedExecutionGeneration: 1,
      outcome: "SUCCEEDED" as const,
      providerResponseDigest: DIGEST_B,
      errorCode: null,
    };
    expect(await repository.resolveCommandOutcome(resolution)).toMatchObject({
      status: "SUCCEEDED",
      provider_response_digest: DIGEST_B,
      state_revision: 3,
    });
    expect(await repository.resolveCommandOutcome(resolution)).toMatchObject({
      status: "SUCCEEDED",
    });
  });

  test("deduplicates exact provider events and lease-CAS applies one revision", async () => {
    expect((await recordEvent()).replayed).toBe(false);
    expect((await recordEvent()).replayed).toBe(true);
    await expect(recordEvent({ payloadDigest: DIGEST_B })).rejects.toMatchObject({
      code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
    });
    expect(await repository.findEventReceipt(ORG_B, RECEIPT)).toBeUndefined();
    const token = randomUUID();
    await repository.claimEvent({
      organizationId: ORG_A,
      receiptId: RECEIPT,
      leaseToken: token,
      leaseDurationMs: 1,
    });
    await Bun.sleep(5);
    expect(await repository.listStuckEvents(10)).toHaveLength(1);
    const takeoverToken = randomUUID();
    expect(
      await repository.claimEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: takeoverToken,
        leaseDurationMs: 60_000,
      }),
    ).toMatchObject({ attempt_count: 2, lease_token: takeoverToken });
    expect(
      await repository.applyEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: randomUUID(),
        subscriptionRevision: 1,
        disposition: "allowance_granted",
      }),
    ).toBeNull();
    expect(
      await repository.applyEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: takeoverToken,
        subscriptionRevision: 1,
        disposition: "allowance_granted",
      }),
    ).toMatchObject({ status: "applied", applied_subscription_revision: 1 });
    expect(
      await repository.applyEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: takeoverToken,
        subscriptionRevision: 1,
        disposition: "allowance_granted",
      }),
    ).toMatchObject({ status: "applied" });
    const failedReceipt = await recordEvent({
      id: randomUUID(),
      providerEventId: "event_failed2",
      providerObjectId: "invoice_failed2",
    });
    const failedToken = randomUUID();
    await repository.claimEvent({
      organizationId: ORG_A,
      receiptId: failedReceipt.value.id,
      leaseToken: failedToken,
      leaseDurationMs: 60_000,
    });
    await repository.failEvent({
      organizationId: ORG_A,
      receiptId: failedReceipt.value.id,
      leaseToken: failedToken,
      status: "failed",
      errorCode: "TRANSIENT_DB_ERROR",
    });
    expect(await repository.listStuckEvents(10)).toHaveLength(1);
    expect(
      await repository.reconcileEvent({
        organizationId: ORG_A,
        receiptId: failedReceipt.value.id,
        outcome: "ignored",
        subscriptionRevision: null,
        disposition: "superseded_event",
        now: at(50),
      }),
    ).toMatchObject({ status: "ignored", error_code: null });
  });

  test("converges reordered authoritative observations and replays a coherent revision", async () => {
    const lifecycle = {
      provider: "stripe" as const,
      provider_environment: "test" as const,
      stripe_customer_id: "cus_repoa",
      stripe_subscription_id: "sub_repoa",
      stripe_subscription_item_id: "si_repoa",
      plan_key: "plus_monthly" as const,
      catalog_version: "v1",
      status: "past_due" as const,
      current_period_start: new Date("2026-08-01T00:00:00Z"),
      current_period_end: new Date("2026-09-01T00:00:00Z"),
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      dunning_started_at: null,
      grace_expires_at: null,
      pending_plan_key: null,
      last_provider_event_id: "evt_newer",
      last_provider_event_created_at: new Date("2026-08-20T00:00:00Z"),
      provider_object_digest: DIGEST_B,
    };
    const newer = await authority.advance({
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      expectedRevision: 1,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: lifecycle,
    });
    expect(newer.revision.revision).toBe(2);
    await expect(
      authority.advance({
        organizationId: ORG_A,
        subscriptionId: SUB_A,
        expectedRevision: 2,
        source: "webhook",
        observation: "authoritative_provider_retrieval",
        values: {
          ...lifecycle,
          status: "past_due",
          last_provider_event_id: "evt_older",
          last_provider_event_created_at: new Date("2026-08-19T00:00:00Z"),
        },
      }),
    ).resolves.toMatchObject({ replayed: false });
    const newest = await authority.advance({
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      expectedRevision: 3,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: {
        ...lifecycle,
        status: "unpaid",
        last_provider_event_id: "evt_newest",
        last_provider_event_created_at: new Date("2026-08-19T00:00:00Z"),
        provider_object_digest: DIGEST_A,
      },
    });
    expect(newest.revision.revision).toBe(4);
    const historicalReplay = await authority.advance({
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      expectedRevision: 4,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: {
        ...lifecycle,
        status: "unpaid",
        provider_object_digest: DIGEST_A,
      },
    });
    expect(historicalReplay).toMatchObject({ replayed: true });
    expect(historicalReplay.subscription.lifecycle_revision).toBe(4);
    expect(historicalReplay.revision.revision).toBe(2);
  });

  test("rebuilds a terminated paid subscription back to the Free projection", async () => {
    const paid = await entitlements.rebuild({
      organizationId: ORG_A,
      expectedProjectionRevision: 0,
      sourceSubscriptionId: SUB_A,
      sourceSubscriptionRevision: 1,
    });
    expect(paid.entitlement).toMatchObject({
      plan_key: "plus_monthly",
      state: "active",
      projection_revision: 1,
    });
    await getPgliteClientForTests().exec(`
      INSERT INTO billing_subscription_revisions (
        organization_id, subscription_id, revision, source, provider_environment,
        stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
        plan_key, catalog_version, status, current_period_start, current_period_end,
        cancel_at_period_end, canceled_at, ended_at, provider_object_digest
      ) VALUES (
        '${ORG_A}', '${SUB_A}', 2, 'webhook', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa',
        'plus_monthly', 'v1', 'canceled', '2026-08-01Z', '2026-09-01Z', false,
        '2026-08-25Z', '2026-08-25Z', '${DIGEST_B}'
      );
      UPDATE billing_subscriptions
      SET status='canceled', lifecycle_revision=2, canceled_at='2026-08-25Z',
          ended_at='2026-08-25Z', provider_object_digest='${DIGEST_B}'
      WHERE id='${SUB_A}';
    `);
    const free = await entitlements.rebuild({
      organizationId: ORG_A,
      expectedProjectionRevision: 1,
      sourceSubscriptionId: SUB_A,
      sourceSubscriptionRevision: 2,
    });
    expect(free.entitlement).toMatchObject({
      plan_key: "free",
      state: "free",
      entitlement_effective: true,
      projection_revision: 2,
      source_subscription_id: null,
      source_subscription_revision: null,
    });
  });

  test("conserves allowance across reserve, partial finalize, release, and cancellation", async () => {
    await getPgliteClientForTests().exec(`
      INSERT INTO subscription_allowance_periods (
        id, organization_id, subscription_id, subscription_revision,
        provider_environment, stripe_invoice_id, plan_key, catalog_version,
        period_start, period_end, expires_at, granted_amount, available_amount
      ) VALUES (
        '${PERIOD}', '${ORG_A}', '${SUB_A}', 1, 'test', 'in_allowance1',
        'plus_monthly', 'v1', '2026-08-01Z', '2099-09-01Z', '2099-09-01Z', 5, 5
      );
      INSERT INTO subscription_allowance_transactions (
        organization_id, allowance_period_id, sequence, kind, amount,
        available_before, available_after, reserved_before, reserved_after,
        settled_before, settled_after, expired_before, expired_after,
        clawed_back_before, clawed_back_after, idempotency_key, request_digest
      ) VALUES (
        '${ORG_A}', '${PERIOD}', 1, 'grant', 5, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0,
        'grant.allowance1', '${DIGEST_A}'
      );
    `);
    const reserved = await writeTransaction((tx) =>
      allowance.reserve(tx, {
        organizationId: ORG_A,
        periodId: PERIOD,
        logicalOperationId: "operation.allowance.reserve1",
        requestDigest: DIGEST_A,
        requestedAmount: microsToMoney(5_000_000n),
        allowanceAmount: microsToMoney(5_000_000n),
        purchasedCreditAmount: microsToMoney(0n),
        purchasedCreditReservationTransactionId: null,
      }),
    );
    expect(reserved.period).toMatchObject({
      available_amount: "0.000000",
      reserved_amount: "5.000000",
    });
    await expect(
      writeTransaction((tx) =>
        allowance.finalize(tx, {
          organizationId: ORG_A,
          reservationId: reserved.reservation.id,
          idempotencyKey: "settle.invalid-credit-reference",
          requestDigest: DIGEST_B,
          actualAllowanceAmount: microsToMoney(3_000_000n),
          actualPurchasedCreditAmount: microsToMoney(0n),
          uncollectedOverageAmount: microsToMoney(0n),
          purchasedCreditSettlementTransactionId: "00000000-0000-4000-8000-000000000099",
          purchasedCreditRefundTransactionId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_FUNDING_CONFLICT" });
    const finalized = await writeTransaction((tx) =>
      allowance.finalize(tx, {
        organizationId: ORG_A,
        reservationId: reserved.reservation.id,
        idempotencyKey: "settle.key.0001",
        requestDigest: DIGEST_B,
        actualAllowanceAmount: microsToMoney(3_000_000n),
        actualPurchasedCreditAmount: microsToMoney(0n),
        uncollectedOverageAmount: microsToMoney(0n),
        purchasedCreditSettlementTransactionId: null,
        purchasedCreditRefundTransactionId: null,
      }),
    );
    expect(finalized.period).toMatchObject({
      available_amount: "2.000000",
      reserved_amount: "0.000000",
      settled_amount: "3.000000",
    });
    const second = await writeTransaction((tx) =>
      allowance.reserve(tx, {
        organizationId: ORG_A,
        periodId: PERIOD,
        logicalOperationId: "operation.allowance.reserve2",
        requestDigest: DIGEST_A,
        requestedAmount: microsToMoney(2_000_000n),
        allowanceAmount: microsToMoney(2_000_000n),
        purchasedCreditAmount: microsToMoney(0n),
        purchasedCreditReservationTransactionId: null,
      }),
    );
    const canceled = await writeTransaction((tx) =>
      allowance.cancel(tx, {
        organizationId: ORG_A,
        reservationId: second.reservation.id,
        idempotencyKey: "cancel.key.0002",
        requestDigest: DIGEST_B,
        purchasedCreditSettlementTransactionId: null,
        purchasedCreditRefundTransactionId: null,
      }),
    );
    expect(canceled.period).toMatchObject({
      available_amount: "2.000000",
      reserved_amount: "0.000000",
      settled_amount: "3.000000",
    });
    expect(
      await writeTransaction((tx) =>
        allowance.cancel(tx, {
          organizationId: ORG_A,
          reservationId: second.reservation.id,
          idempotencyKey: "cancel.key.0002",
          requestDigest: DIGEST_B,
          purchasedCreditSettlementTransactionId: null,
          purchasedCreditRefundTransactionId: null,
        }),
      ),
    ).toMatchObject({ replayed: true });
  });

  test("forfeits a partial reservation release after its allowance period expires", async () => {
    await getPgliteClientForTests().exec(`
      INSERT INTO subscription_allowance_periods (
        id, organization_id, subscription_id, subscription_revision,
        provider_environment, stripe_invoice_id, plan_key, catalog_version,
        period_start, period_end, expires_at, granted_amount, available_amount
      ) VALUES (
        '${EXPIRED_PERIOD}', '${ORG_A}', '${SUB_A}', 1, 'test', 'in_expired1',
        'plus_monthly', 'v1', '2026-08-01Z', '2099-09-01Z', '2099-09-01Z', 5, 5
      );
      INSERT INTO subscription_allowance_transactions (
        organization_id, allowance_period_id, sequence, kind, amount,
        available_before, available_after, reserved_before, reserved_after,
        settled_before, settled_after, expired_before, expired_after,
        clawed_back_before, clawed_back_after, idempotency_key, request_digest
      ) VALUES (
        '${ORG_A}', '${EXPIRED_PERIOD}', 1, 'grant', 5, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0,
        'grant.expired-release', '${DIGEST_A}'
      );
    `);
    const reserved = await writeTransaction((tx) =>
      allowance.reserve(tx, {
        organizationId: ORG_A,
        periodId: EXPIRED_PERIOD,
        logicalOperationId: "operation.allowance.expired-release",
        requestDigest: DIGEST_A,
        requestedAmount: microsToMoney(5_000_000n),
        allowanceAmount: microsToMoney(5_000_000n),
        purchasedCreditAmount: microsToMoney(0n),
        purchasedCreditReservationTransactionId: null,
      }),
    );
    await getPgliteClientForTests().exec(`
      UPDATE subscription_allowance_periods
      SET period_start = '1999-01-01Z', period_end = '2000-01-01Z', expires_at = '2000-01-01Z'
      WHERE id = '${EXPIRED_PERIOD}';
    `);

    const finalized = await writeTransaction((tx) =>
      allowance.finalize(tx, {
        organizationId: ORG_A,
        reservationId: reserved.reservation.id,
        idempotencyKey: "settle.expired-release",
        requestDigest: DIGEST_B,
        actualAllowanceAmount: microsToMoney(3_000_000n),
        actualPurchasedCreditAmount: microsToMoney(0n),
        uncollectedOverageAmount: microsToMoney(0n),
        purchasedCreditSettlementTransactionId: null,
        purchasedCreditRefundTransactionId: null,
      }),
    );
    expect(finalized.period).toMatchObject({
      available_amount: "0.000000",
      reserved_amount: "0.000000",
      settled_amount: "3.000000",
      expired_amount: "2.000000",
    });
    const releaseRows = await getPgliteClientForTests().query<{
      kind: string;
      amount: string;
      idempotency_key: string;
    }>(
      `SELECT kind, amount, idempotency_key
       FROM subscription_allowance_transactions
       WHERE allowance_period_id = $1 AND kind = 'expired_refund'`,
      [EXPIRED_PERIOD],
    );
    expect(releaseRows.rows).toEqual([
      {
        kind: "expired_refund",
        amount: "2.000000",
        idempotency_key: `${reserved.allocations[0]?.id}.release.${DIGEST_B.slice(0, 16)}`,
      },
    ]);
  });

  test("records exact incidents, scans due work, and resolves tenant-scoped evidence", async () => {
    await enqueue();
    await recordEvent();
    const input = {
      id: INCIDENT,
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      commandId: COMMAND,
      eventReceiptId: RECEIPT,
      kind: "provider_timeout" as const,
      severity: "error" as const,
      fingerprint: DIGEST_A,
      context: { provider: "stripe", timeout_ms: 10_000 },
      nextRetryAt: at(100),
      now: at(0),
    };
    expect((await repository.openIncident(input)).replayed).toBe(false);
    expect(await repository.openIncident(input)).toMatchObject({
      replayed: true,
      value: { occurrence_count: 2 },
    });
    expect(
      await repository.openIncident({
        ...input,
        context: { timeout_ms: 10_000, provider: "stripe" },
      }),
    ).toMatchObject({ replayed: true, value: { occurrence_count: 3 } });
    await expect(
      repository.openIncident({ ...input, context: { provider: "stripe", timeout_ms: 1 } }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT" });
    expect(await repository.listDueIncidents(at(99), 10)).toHaveLength(0);
    expect(await repository.listDueIncidents(at(100), 10)).toHaveLength(1);
    expect(
      await repository.resolveIncident({
        organizationId: ORG_B,
        incidentId: INCIDENT,
        resolvedByUserId: null,
        resolution: "reconciled",
        now: at(200),
      }),
    ).toBeNull();
    expect(
      await repository.resolveIncident({
        organizationId: ORG_A,
        incidentId: INCIDENT,
        resolvedByUserId: null,
        resolution: "reconciled",
        now: at(200),
      }),
    ).toMatchObject({ status: "resolved" });
  });

  test("advances deletion fences by local revision without inventing a provider version", async () => {
    const created = await repository.createFence({
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      providerEventId: null,
      providerEventCreatedAt: null,
      providerObjectDigest: DIGEST_A,
      nextReconcileAt: at(100),
      now: at(0),
    });
    expect(created.replayed).toBe(false);
    expect(await repository.findFence(ORG_B, SUB_A)).toBeUndefined();
    expect(await repository.listDueFences(at(99), 10)).toHaveLength(0);
    expect(await repository.listDueFences(at(100), 10)).toHaveLength(1);
    const advance = {
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      expectedFenceRevision: 1,
      state: "deletion_requested" as const,
      providerEventId: "evt_delete1",
      providerEventCreatedAt: at(10),
      providerObjectDigest: DIGEST_B,
      deletionRequestedAt: at(20),
      providerDeletedAt: null,
      releasedAt: null,
      lastReconciledAt: at(20),
      nextReconcileAt: at(200),
      now: at(20),
    };
    expect(await repository.advanceFence(advance)).toMatchObject({
      replayed: false,
      value: { fence_revision: 2, state: "deletion_requested" },
    });
    expect(await repository.advanceFence(advance)).toMatchObject({ replayed: true });
    expect(
      await repository.advanceFence({
        ...advance,
        expectedFenceRevision: 1,
        providerObjectDigest: DIGEST_A,
      }),
    ).toBeNull();
  });
});
