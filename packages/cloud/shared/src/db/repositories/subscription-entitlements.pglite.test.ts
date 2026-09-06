/** Exercises entitlement publication against a real PGlite database, including replay, replacement and transaction rollback. */
import {
  afterAll,
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
let writeTransaction: typeof import("../helpers").writeTransaction;
function getPgliteClientForTests() {
  return client.getPgliteClientForTests();
}
beforeAll(async () => {
  client = await import("../client");
  ({ subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  ));
  ({ subscriptionAuthorityRepository: authority } = await import("./subscription-authority"));
  ({ writeTransaction } = await import("../helpers"));
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
  const { applyAppBillingTestMigrations } = await import("./app-billing-test-migrations");
  await applyAppBillingTestMigrations((statement) => getPgliteClientForTests().exec(statement));
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
async function advanceToGrace(deadline: string) {
  await getPgliteClientForTests().exec(`
    UPDATE billing_subscriptions SET lifecycle_revision = 2, status = 'grace', dunning_started_at = '2026-08-20Z', grace_expires_at = '${deadline}' WHERE id = '${SUB_A}';
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, provider_environment,
      stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      cancel_at_period_end, provider_object_digest, dunning_started_at, grace_expires_at
    ) VALUES ('${ORG_A}', '${SUB_A}', 2, 'webhook', 'test', 'cus_repoa', 'sub_repoa', 'si_repoa', 'plus_monthly', 'v1', 'grace', '2026-08-01Z', '2026-09-01Z', false, '${DIGEST_A}', '2026-08-20Z', '${deadline}');
  `);
}
describe("current-source entitlement publication", () => {
  test("an old request cannot replay a projection after lifecycle authority advances", async () => {
    const first = await entitlements.rebuild(request);
    expect((await entitlements.rebuild(request)).replayed).toBe(true);
    await advanceToGrace("2026-08-27Z");
    await expect(entitlements.rebuild(request)).rejects.toMatchObject({
      code: "SUBSCRIPTION_ENTITLEMENT_CONFLICT",
    });
    expect(await entitlements.find(ORG_A)).toEqual(first.entitlement);
    const next = await entitlements.rebuild({
      ...request,
      sourceSubscriptionRevision: 2,
      expectedProjectionRevision: 1,
    });
    expect(next.entitlement.effective_until?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
    expect(next.entitlement.state).toBe("grace");
  });
  test.each(["2026-08-27Z", "2026-09-10Z"])(
    "publishes the actual grace deadline %s",
    async (deadline) => {
      await advanceToGrace(deadline);
      const next = await entitlements.rebuild({ ...request, sourceSubscriptionRevision: 2 });
      expect(next.entitlement.effective_until?.getTime()).toBe(Date.parse(deadline));
    },
  );
  test("a missing grace deadline leaves the prior projection unchanged", async () => {
    const first = await entitlements.rebuild(request);
    await advanceToGrace("2026-08-27Z");
    await getPgliteClientForTests().exec(
      `UPDATE billing_subscriptions SET grace_expires_at = NULL, dunning_started_at = NULL WHERE id = '${SUB_A}';`,
    );
    await expect(
      entitlements.rebuild({
        ...request,
        sourceSubscriptionRevision: 2,
        expectedProjectionRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_ENTITLEMENT_CONFLICT" });
    expect(await entitlements.find(ORG_A)).toEqual(first.entitlement);
  });
  test("tenant mismatch cannot publish another organization's subscription", async () => {
    await expect(entitlements.rebuild({ ...request, organizationId: ORG_B })).rejects.toMatchObject(
      { code: "SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND" },
    );
    expect((await entitlements.find(ORG_B))?.plan_key).toBe("free");
  });
  test("concurrent different source publications retain the current revision", async () => {
    await advanceToGrace("2026-09-10Z");
    const results = await Promise.allSettled([
      entitlements.rebuild(request),
      entitlements.rebuild({ ...request, sourceSubscriptionRevision: 2 }),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    expect((await entitlements.find(ORG_A))?.source_subscription_revision).toBe(2);
  });
  test("projection and outer lifecycle work roll back in the same transaction", async () => {
    await expect(
      writeTransaction(async (tx) => {
        await entitlements.rebuildInTransaction(tx, request);
        throw new Error("outer operation failed");
      }),
    ).rejects.toThrow("outer operation failed");
    expect((await entitlements.find(ORG_A))?.plan_key).toBe("free");
    expect((await entitlements.rebuild(request)).entitlement.source_subscription_revision).toBe(1);
  });
  test("account erasure releases the reverse pointer only behind the irreversible fence", async () => {
    await expect(
      writeTransaction((tx) => authority.releaseForAccountDeletion(tx, ORG_A)),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_AUTHORITY_CONFLICT" });
    await getPgliteClientForTests().exec(
      `UPDATE organizations SET account_lifecycle_state='deletion_irreversible' WHERE id='${ORG_A}'`,
    );
    await expect(
      writeTransaction(async (tx) => {
        await authority.releaseForAccountDeletion(tx, ORG_A);
        throw new Error("erase failed");
      }),
    ).rejects.toThrow("erase failed");
    const rollback = await getPgliteClientForTests().query(
      `SELECT subscription_id FROM organization_subscription_authorities WHERE organization_id='${ORG_A}'`,
    );
    expect(rollback.rows).toEqual([{ subscription_id: SUB_A }]);
    await writeTransaction(async (tx) => {
      await authority.releaseForAccountDeletion(tx, ORG_A);
      const { sql } = await import("drizzle-orm");
      await tx.execute(
        sql`SELECT set_config('eliza.subscription_account_deletion_authority', 'on', true)`,
      );
      await tx.execute(sql`DELETE FROM organization_entitlements WHERE organization_id=${ORG_A}`);
      await tx.execute(
        sql`DELETE FROM billing_subscription_revisions WHERE organization_id=${ORG_A}`,
      );
      await tx.execute(sql`DELETE FROM billing_subscriptions WHERE organization_id=${ORG_A}`);
      await tx.execute(sql`DELETE FROM organizations WHERE id=${ORG_A}`);
    });
    expect(await entitlements.find(ORG_A)).toBeUndefined();
    expect(await authority.findById(ORG_A, SUB_A)).toBeUndefined();
    expect(await authority.findById(ORG_B, SUB_B)).toBeDefined();
  });

  test.each(["active", "canceled"] as const)(
    "retains explicit replacement %s identity even with equal creation timestamps",
    async (status) => {
      const original = await authority.findById(ORG_A, SUB_A);
      if (!original) throw new Error("Missing seeded subscription");
      const values = {
        provider: original.provider,
        provider_environment: original.provider_environment,
        stripe_customer_id: original.stripe_customer_id,
        stripe_subscription_id: original.stripe_subscription_id,
        stripe_subscription_item_id: original.stripe_subscription_item_id,
        catalog_version: original.catalog_version,
        plan_key: original.plan_key,
        status: "canceled" as const,
        current_period_start: original.current_period_start,
        current_period_end: original.current_period_end,
        cancel_at_period_end: false,
        canceled_at: new Date("2026-08-25Z"),
        ended_at: new Date("2026-08-25Z"),
        dunning_started_at: null,
        grace_expires_at: null,
        pending_plan_key: null,
        last_provider_event_id: null,
        last_provider_event_created_at: null,
        provider_object_digest: DIGEST_A,
      };
      await authority.advance({
        organizationId: ORG_A,
        subscriptionId: SUB_A,
        expectedRevision: 1,
        source: "webhook",
        observation: "authoritative_provider_retrieval",
        values,
      });
      const replacement = await authority.create(
        {
          ...values,
          id: REPLACEMENT,
          organization_id: ORG_A,
          stripe_subscription_id: "sub_replacement",
          stripe_subscription_item_id: "si_replacement",
          plan_key: "pro_monthly",
          status,
        },
        "checkout",
        SUB_A,
      );
      await getPgliteClientForTests().exec(
        `UPDATE billing_subscriptions SET created_at='2026-08-01Z' WHERE organization_id='${ORG_A}'`,
      );
      const current = await entitlements.rebuild({
        ...request,
        sourceSubscriptionId: replacement.subscription.id,
        sourceSubscriptionRevision: 1,
      });
      expect(current.entitlement.source_subscription_id).toBe(REPLACEMENT);
      expect(current.entitlement.plan_key).toBe(status === "active" ? "pro_monthly" : "free");
      await expect(
        entitlements.rebuild({
          ...request,
          sourceSubscriptionRevision: 2,
          expectedProjectionRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_ENTITLEMENT_CONFLICT" });
      await expect(
        authority.advance({
          organizationId: ORG_A,
          subscriptionId: SUB_A,
          expectedRevision: 2,
          source: "webhook",
          observation: "authoritative_provider_retrieval",
          values,
        }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_AUTHORITY_CONFLICT" });
      await expect(
        authority.create({ ...values, id: SUB_A, organization_id: ORG_A }, "checkout", null),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_AUTHORITY_CONFLICT" });
      if (status === "canceled") {
        await expect(
          authority.create(
            {
              ...values,
              id: "53000000-0000-4000-8000-000000000004",
              organization_id: ORG_A,
              stripe_subscription_id: "sub_delayed",
              stripe_subscription_item_id: "si_delayed",
            },
            "checkout",
            SUB_A,
          ),
        ).rejects.toMatchObject({ code: "SUBSCRIPTION_AUTHORITY_CONFLICT" });
        expect(
          await authority.findById(ORG_A, "53000000-0000-4000-8000-000000000004"),
        ).toBeUndefined();
      }
      expect(await entitlements.find(ORG_A)).toEqual(current.entitlement);
    },
  );
});
