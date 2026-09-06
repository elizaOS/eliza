/** Exercises entitlement publication against a real PGlite database, including atomic lifecycle publication, leases and actual billing admission readback. */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);
const ORG_A = "51000000-0000-4000-8000-000000000001";
const ORG_B = "51000000-0000-4000-8000-000000000002";
const USER = "52000000-0000-4000-8000-000000000001";
const SUB_A = "53000000-0000-4000-8000-000000000001";
const SUB_B = "53000000-0000-4000-8000-000000000002";
const REPLACEMENT = "53000000-0000-4000-8000-000000000003";
const DIGEST_A = "a".repeat(64);
let client: typeof import("../client");
let entitlements: import("./subscription-entitlements").SubscriptionEntitlementsRepository;
let authority: import("./subscription-authority").SubscriptionAuthorityRepository;
let operations: import("./subscription-billing-operations").SubscriptionBillingOperationsRepository;
let isSubscriptionFundedOrganization: typeof import("../../lib/services/ai-billing").isSubscriptionFundedOrganization;
function getPgliteClientForTests() {
  return client.getPgliteClientForTests();
}
beforeAll(async () => {
  client = await import("../client");
  ({ subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  ));
  ({ subscriptionAuthorityRepository: authority } = await import("./subscription-authority"));
  ({ subscriptionBillingOperationsRepository: operations } = await import(
    "./subscription-billing-operations"
  ));
  ({ isSubscriptionFundedOrganization } = await import("../../lib/services/ai-billing"));
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, account_lifecycle_state text NOT NULL DEFAULT 'active', paid_work_fenced_at timestamptz, stripe_customer_id text);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id));
  `);
  const migration = await readFile(
    new URL("../migrations/0373_subscription_authority.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
  const eraseMigration = await readFile(
    new URL("../migrations/0374_subscription_funding_transaction_uniqueness.sql", import.meta.url),
    "utf8",
  );
  for (const statement of eraseMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
  const identityMigration = await readFile(
    new URL("../migrations/0379_subscription_account_authority.sql", import.meta.url),
    "utf8",
  );
  for (const statement of identityMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
});
beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    ALTER TABLE billing_subscription_revisions DISABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions DISABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    TRUNCATE TABLE billing_subscriptions, users, organizations CASCADE;
    ALTER TABLE billing_subscription_revisions ENABLE TRIGGER billing_subscription_revisions_immutable_guard;
    ALTER TABLE subscription_allowance_transactions ENABLE TRIGGER subscription_allowance_transactions_immutable_guard;
    INSERT INTO organizations (id, stripe_customer_id) VALUES ('${ORG_A}', 'cus_repoa'), ('${ORG_B}', 'cus_repob');
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
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_A}', state = 'current' WHERE organization_id = '${ORG_A}';
    UPDATE organization_subscription_authorities SET subscription_id = '${SUB_B}', state = 'current' WHERE organization_id = '${ORG_B}';
  `);
});

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
const request = {
  organizationId: ORG_A,
  sourceSubscriptionId: SUB_A,
  sourceSubscriptionRevision: 1,
  expectedProjectionRevision: 0,
};

const RECEIPT = "54000000-0000-4000-8000-000000000001";
const LEASE = "55000000-0000-4000-8000-000000000001";
const EVENT_TIME = new Date("2026-08-25T00:00:00Z");

async function observeTerminal() {
  const current = await authority.findById(ORG_A, SUB_A);
  if (!current) throw new Error("Missing lifecycle source");
  return {
    provider: current.provider,
    provider_environment: current.provider_environment,
    stripe_customer_id: current.stripe_customer_id,
    stripe_subscription_id: current.stripe_subscription_id,
    stripe_subscription_item_id: current.stripe_subscription_item_id,
    catalog_version: current.catalog_version,
    plan_key: current.plan_key,
    status: "canceled" as const,
    current_period_start: current.current_period_start,
    current_period_end: current.current_period_end,
    cancel_at_period_end: false,
    canceled_at: EVENT_TIME,
    ended_at: EVENT_TIME,
    dunning_started_at: null,
    grace_expires_at: null,
    pending_plan_key: null,
    last_provider_event_id: "evt_terminal",
    last_provider_event_created_at: EVENT_TIME,
    provider_object_digest: "b".repeat(64),
  };
}

async function prepare(kind: "subscription" | "invoice" = "subscription") {
  await entitlements.rebuild(request);
  await operations.recordEvent({
    id: RECEIPT,
    organizationId: ORG_A,
    subscriptionId: SUB_A,
    providerEventId: "evt_terminal",
    eventType: kind === "invoice" ? "invoice.paid" : "customer.subscription.deleted",
    providerObjectType: kind,
    providerObjectId: kind === "invoice" ? "in_paid" : "sub_repoa",
    livemode: false,
    eventCreatedAt: EVENT_TIME,
    payloadDigest: "c".repeat(64),
    now: new Date(),
  });
  await operations.claimEvent({
    organizationId: ORG_A,
    receiptId: RECEIPT,
    leaseToken: LEASE,
    leaseDurationMs: 60_000,
  });
  return {
    organizationId: ORG_A,
    subscriptionId: SUB_A,
    receiptId: RECEIPT,
    leaseToken: LEASE,
    expectedSubscriptionRevision: 1,
    expectedProjectionRevision: 1,
    observation: await observeTerminal(),
  };
}

async function expectUnapplied() {
  expect((await authority.findById(ORG_A, SUB_A))?.lifecycle_revision).toBe(1);
  expect(await authority.listRevisions(ORG_A, SUB_A)).toHaveLength(1);
  expect((await entitlements.find(ORG_A))?.plan_key).toBe("plus_monthly");
  expect((await operations.findEventReceipt(ORG_A, RECEIPT))?.status).toBe("processing");
}

afterEach(async () => {
  await getPgliteClientForTests().exec(`
    DROP TRIGGER IF EXISTS fail_projection ON organization_entitlements;
    DROP TRIGGER IF EXISTS fail_receipt ON billing_subscription_event_receipts;
  `);
});

describe("atomic terminal subscription finalization", () => {
  test("commits lifecycle, current projection and receipt before billing admission sees Free", async () => {
    const input = await prepare();
    expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(true);
    const result = await operations.finalizeLifecycleEvent(input);
    expect(result.outcome).toBe("applied");
    const lifecycle = await authority.findById(ORG_A, SUB_A);
    const projection = await entitlements.find(ORG_A);
    const receipt = await operations.findEventReceipt(ORG_A, RECEIPT);
    expect(lifecycle?.status).toBe("canceled");
    expect(projection).toMatchObject({
      plan_key: "free",
      source_subscription_id: SUB_A,
      source_subscription_revision: lifecycle?.lifecycle_revision,
    });
    expect(receipt).toMatchObject({
      status: "applied",
      applied_subscription_revision: lifecycle?.lifecycle_revision,
    });
    expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(false);
    const grants = await getPgliteClientForTests().query(
      "SELECT * FROM subscription_allowance_transactions",
    );
    expect(grants.rows).toEqual([]);
  });

  test("a projection failure rolls back the lifecycle journal and leaves the receipt retryable", async () => {
    const input = await prepare();
    await getPgliteClientForTests().exec(`
      CREATE OR REPLACE FUNCTION reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected projection failure'; END $$;
      CREATE TRIGGER fail_projection BEFORE UPDATE ON organization_entitlements
      FOR EACH ROW EXECUTE FUNCTION reject_projection();
    `);
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toThrow();
    await expectUnapplied();
  });

  test("a receipt failure rolls back both lifecycle and projection", async () => {
    const input = await prepare();
    await getPgliteClientForTests().exec(`
      CREATE OR REPLACE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$;
      CREATE TRIGGER fail_receipt BEFORE UPDATE ON billing_subscription_event_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_receipt();
    `);
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toThrow();
    await expectUnapplied();
  });

  test("lease expiration after projection still rolls back every domain write", async () => {
    const input = await prepare();
    await getPgliteClientForTests().exec(`
      CREATE OR REPLACE FUNCTION expire_finalization_lease() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE billing_subscription_event_receipts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='${RECEIPT}';
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_projection AFTER UPDATE ON organization_entitlements
      FOR EACH ROW EXECUTE FUNCTION expire_finalization_lease();
    `);
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_LIFECYCLE_LEASE_LOST",
    });
    await expectUnapplied();
    expect(
      (await operations.findEventReceipt(ORG_A, RECEIPT))?.lease_expires_at?.getTime(),
    ).toBeGreaterThan(Date.now());
  });

  test("a lease that expired during provider retrieval cannot write domain state", async () => {
    const input = await prepare();
    await getPgliteClientForTests().exec(
      `UPDATE billing_subscription_event_receipts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='${RECEIPT}'`,
    );
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_LIFECYCLE_LEASE_LOST",
    });
    await expectUnapplied();
  });

  test("stale source and stale projection CAS cannot be hidden by lifecycle replay", async () => {
    const input = await prepare();
    await expect(
      operations.finalizeLifecycleEvent({ ...input, expectedProjectionRevision: 0 }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_ENTITLEMENT_CONFLICT" });
    await expectUnapplied();
    await authority.advance({
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      expectedRevision: 1,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: {
        ...input.observation,
        last_provider_event_id: "evt_other",
        provider_object_digest: "d".repeat(64),
      },
    });
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_LIFECYCLE_REOBSERVE",
    });
    expect((await operations.findEventReceipt(ORG_A, RECEIPT))?.status).toBe("processing");
    expect((await authority.findById(ORG_A, SUB_A))?.lifecycle_revision).toBe(2);
    expect((await entitlements.find(ORG_A))?.plan_key).toBe("plus_monthly");
  });

  for (const mismatch of ["active", "digest", "terminal_time"] as const) {
    test(`current event replay with different ${mismatch} cannot finalize its receipt`, async () => {
      const input = await prepare();
      await authority.advance({
        organizationId: ORG_A,
        subscriptionId: SUB_A,
        expectedRevision: 1,
        source: "webhook",
        observation: "authoritative_provider_retrieval",
        values: {
          ...input.observation,
          ...(mismatch === "active"
            ? { status: "active" as const, canceled_at: null, ended_at: null }
            : mismatch === "digest"
              ? { provider_object_digest: "d".repeat(64) }
              : { ended_at: new Date("2026-08-24T00:00:00Z") }),
        },
      });
      const sourceBefore = await authority.findById(ORG_A, SUB_A);
      const projectionBefore = await entitlements.find(ORG_A);
      const receiptBefore = await operations.findEventReceipt(ORG_A, RECEIPT);
      await expect(
        operations.finalizeLifecycleEvent({ ...input, expectedSubscriptionRevision: 2 }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_LIFECYCLE_REOBSERVE" });
      expect(await authority.findById(ORG_A, SUB_A)).toEqual(sourceBefore);
      expect(await authority.listRevisions(ORG_A, SUB_A)).toHaveLength(2);
      expect(await entitlements.find(ORG_A)).toEqual(projectionBefore);
      expect(await operations.findEventReceipt(ORG_A, RECEIPT)).toEqual(receiptBefore);
      if (mismatch === "active") {
        expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(true);
      }
    });
  }

  test("matching current event replay can finish a previously unfinalized terminal receipt", async () => {
    const input = await prepare();
    await authority.advance({
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      expectedRevision: 1,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: input.observation,
    });
    const result = await operations.finalizeLifecycleEvent({
      ...input,
      expectedSubscriptionRevision: 2,
    });
    expect(result.outcome).toBe("applied");
    expect(await authority.listRevisions(ORG_A, SUB_A)).toHaveLength(2);
    expect((await operations.findEventReceipt(ORG_A, RECEIPT))?.status).toBe("applied");
    expect((await entitlements.find(ORG_A))?.plan_key).toBe("free");
    expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(false);
  });

  test("response-loss replay returns historical receipt without overwriting a replacement's admission", async () => {
    const input = await prepare();
    await operations.finalizeLifecycleEvent(input);
    const {
      last_provider_event_id: _event,
      last_provider_event_created_at: _time,
      ...values
    } = input.observation;
    await authority.create(
      {
        ...values,
        organization_id: ORG_A,
        id: REPLACEMENT,
        stripe_subscription_id: "sub_replacement",
        stripe_subscription_item_id: "si_replacement",
        status: "active",
        canceled_at: null,
        ended_at: null,
        last_provider_event_id: null,
        last_provider_event_created_at: null,
      },
      "checkout",
      SUB_A,
    );
    const replacement = await entitlements.rebuild({
      organizationId: ORG_A,
      sourceSubscriptionId: REPLACEMENT,
      sourceSubscriptionRevision: 1,
      expectedProjectionRevision: 2,
    });
    const replay = await operations.finalizeLifecycleEvent(input);
    expect(replay.outcome).toBe("already_applied");
    expect(await entitlements.find(ORG_A)).toEqual(replacement.entitlement);
    expect(await isSubscriptionFundedOrganization(ORG_A)).toBe(true);
    expect(await authority.listRevisions(ORG_A, SUB_A)).toHaveLength(2);
  });

  test.each(["active", "grace", "trialing", "past_due"])(
    "unsupported %s policy cannot publish or apply receipt",
    async (status) => {
      const input = await prepare();
      await expect(
        operations.finalizeLifecycleEvent({
          ...input,
          observation: { ...input.observation, status },
        }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_LIFECYCLE_UNSUPPORTED" });
      await expectUnapplied();
    },
  );

  test.each([
    { provider_environment: "live" },
    { stripe_customer_id: "cus_other" },
    { stripe_subscription_item_id: "si_other" },
    { plan_key: "pro_monthly" },
    { current_period_end: new Date("2026-10-01Z") },
    { current_period_start: new Date("invalid") },
  ])("mismatched provider/plan/period observation fails closed: %j", async (changes) => {
    const input = await prepare();
    await expect(
      operations.finalizeLifecycleEvent({
        ...input,
        observation: { ...input.observation, ...changes },
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_LIFECYCLE_UNSUPPORTED" });
    await expectUnapplied();
  });

  test("deleted-account, cross-tenant and unavailable authority cannot finalize", async () => {
    const input = await prepare();
    await expect(
      operations.finalizeLifecycleEvent({ ...input, organizationId: ORG_B }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT" });
    await getPgliteClientForTests().exec(
      `UPDATE organizations SET account_lifecycle_state='deletion_irreversible' WHERE id='${ORG_A}'`,
    );
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_LIFECYCLE_UNSUPPORTED",
    });
    await getPgliteClientForTests().exec(
      `UPDATE organizations SET account_lifecycle_state='active' WHERE id='${ORG_A}'; UPDATE organization_subscription_authorities SET subscription_id=NULL, state='unavailable' WHERE organization_id='${ORG_A}'`,
    );
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_LIFECYCLE_REOBSERVE",
    });
    await expectUnapplied();
  });
  test("an immutable invoice receipt cannot enter terminal lifecycle finalization", async () => {
    const input = await prepare("invoice");
    await expect(operations.finalizeLifecycleEvent(input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_LIFECYCLE_UNSUPPORTED",
    });
    await expectUnapplied();
  });
});
