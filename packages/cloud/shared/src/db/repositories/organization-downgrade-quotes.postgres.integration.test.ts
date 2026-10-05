/** Actual PostgreSQL migration and quote authority; no provider mutations. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { seedOrganizationDowngradeTestAccount } from "./organization-downgrade-test-fixture";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `lower_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function seed(validityMs = 60000) {
  return seedOrganizationDowngradeTestAccount((q, v) => db.query(q, v), validityMs);
}

(url ? describe : describe.skip)("downgrade quote PostgreSQL authority", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("lower quote is readable but never admissible as an upgrade", async () => {
    const f = await seed();
    const { readOrganizationDowngradeQuote } = await import("./organization-downgrade-quotes");
    expect((await readOrganizationDowngradeQuote(f.input, f.quote.id)).review).toEqual(
      f.quote.review,
    );
    const { prepareOrganizationUpgrade } = await import("./organization-upgrade-commands");
    await expect(
      prepareOrganizationUpgrade({ ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM billing_subscription_commands WHERE organization_id=$1",
          [f.input.organizationId],
        )
      ).rows[0],
    ).toEqual({ n: 0 });
  });
  test("database rejects lower terms without the original period boundary and provider binding", async () => {
    const f = await seed();
    for (const [review, binding] of [
      [{ ...f.quote.review, effectiveAt: f.quote.review.observedAt }, f.quote.provider_binding],
      [f.quote.review, null],
    ]) {
      await expect(
        db.query(
          `INSERT INTO organization_plan_change_quotes
   (organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,provider_binding,created_at,expires_at)
   SELECT organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,$2::jsonb,$3::jsonb,created_at,expires_at FROM organization_plan_change_quotes WHERE id=$1`,
          [f.quote.id, JSON.stringify(review), binding === null ? null : JSON.stringify(binding)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
  test("a committed manager revocation removes access to an existing lower quote", async () => {
    const f = await seed();
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
    const { readOrganizationDowngradeQuote } = await import("./organization-downgrade-quotes");
    await expect(readOrganizationDowngradeQuote(f.input, f.quote.id)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN",
    });
  });
  test("concurrent lower confirmations consume the quote once and retain the original command", async () => {
    const f = await seed();
    const { prepareOrganizationDowngrade: prepare } = await import(
      "./organization-downgrade-commands"
    );
    const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
    const results = await Promise.all([
      prepare(input),
      prepare({ ...input, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((x) => x.created)).toHaveLength(1);
    expect(new Set(results.map((x) => x.command.id)).size).toBe(1);
    expect(results[0]!.command).toMatchObject({
      kind: "downgrade",
      status: "PREPARED",
      provider_started_at: null,
      organization_upgrade_dispatch_state: null,
    });
    expect(
      (
        await db.query(
          "SELECT consumed_by_command_id FROM organization_plan_change_quotes WHERE id=$1",
          [f.quote.id],
        )
      ).rows[0].consumed_by_command_id,
    ).toBe(results[0]!.command.id);
    expect(
      (
        await db.query(
          "SELECT plan_key,pending_plan_key,lifecycle_revision FROM billing_subscriptions WHERE id=$1",
          [f.input.subscriptionId],
        )
      ).rows[0],
    ).toMatchObject({ plan_key: "pro_monthly", pending_plan_key: null, lifecycle_revision: "1" });
    expect(
      (await db.query("SELECT count(*)::int n FROM subscription_allowance_transactions")).rows[0],
    ).toEqual({ n: 0 });
  });
  test("an existing retry key cannot switch lower quotes and another quote cannot create a competing intent", async () => {
    const f = await seed();
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    const { saveOrganizationDowngradeQuote } = await import("./organization-downgrade-quotes");
    const second = await saveOrganizationDowngradeQuote({
      retainedTerms: f.retainedTerms,
      identity: f.input,
      captured: await readOrganizationPlanChangeSource(f.input),
      review: f.quote.review,
      providerBinding: f.quote.provider_binding!,
    });
    const { prepareOrganizationDowngrade: prepare } = await import(
      "./organization-downgrade-commands"
    );
    const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
    await prepare(input);
    await expect(prepare({ ...input, quoteId: second.id })).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
    await expect(
      prepare({ ...input, quoteId: second.id, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM billing_subscription_commands WHERE organization_id=$1",
          [f.input.organizationId],
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });
  test("a quote or retry never transfers manager, actor or tenant authority", async () => {
    const f = await seed();
    const { prepareOrganizationDowngrade: prepare } = await import(
      "./organization-downgrade-commands"
    );
    const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
    await prepare(input);
    await expect(prepare({ ...input, actorId: randomUUID() })).rejects.toThrow();
    await expect(prepare({ ...input, organizationId: randomUUID() })).rejects.toThrow();
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
    await expect(prepare(input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN",
    });
  });
  test("lower admission cannot consume an upgrade review", async () => {
    const { seedOrganizationUpgradeTestAccount } = await import(
      "./organization-upgrade-test-fixture"
    );
    const f = await seedOrganizationUpgradeTestAccount((q, v) => db.query(q, v));
    const { saveOrganizationUpgradeQuote } = await import("./organization-upgrade-quotes");
    const q = await saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      review: f.review,
      providerBinding: f.providerBinding,
    });
    const { prepareOrganizationDowngrade } = await import("./organization-downgrade-commands");
    await expect(
      prepareOrganizationDowngrade({ ...f.input, quoteId: q.id, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT" });
  });
  test("an expired unclaimed lower intent retires without resetting its original quote", async () => {
    const f = await seed(2500);
    const { prepareOrganizationDowngrade: prepare } = await import(
      "./organization-downgrade-commands"
    );
    const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
    const original = await prepare(input);
    await Bun.sleep(2600);
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    await readOrganizationPlanChangeSource(f.input);
    const replay = await prepare({ ...input, idempotencyKey: randomUUID() });
    expect(replay.created).toBe(false);
    expect(replay.command.id).toBe(original.command.id);
    expect(replay.command.status).toBe("SUPERSEDED");
    expect(replay.command.error_code).toBe("DOWNGRADE_REVIEW_EXPIRED_BEFORE_DISPATCH");
  }, 20000);
  test("expiry never retires an uncertain lower effect or grants a competing intent", async () => {
    const f = await seed(2500);
    const { prepareOrganizationDowngrade: prepare } = await import(
      "./organization-downgrade-commands"
    );
    const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
    const original = await prepare(input);
    await db.query(
      "UPDATE billing_subscription_commands SET status='OUTCOME_UNKNOWN',execution_generation=1,provider_started_at=clock_timestamp(),state_revision=state_revision+1 WHERE id=$1",
      [original.command.id],
    );
    await Bun.sleep(2600);
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    await expect(readOrganizationPlanChangeSource(f.input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
    expect((await prepare(input)).command.status).toBe("OUTCOME_UNKNOWN");
  }, 20000);
  test("expiry cannot retire a lower intent while its original lease remains live", async () => {
    const f = await seed(2500);
    const { prepareOrganizationDowngrade: prepare } = await import(
      "./organization-downgrade-commands"
    );
    const input = { ...f.input, quoteId: f.quote.id, idempotencyKey: randomUUID() };
    const original = await prepare(input);
    await db.query(
      "UPDATE billing_subscription_commands SET lease_token=$2,lease_expires_at=clock_timestamp()+interval '60 seconds',state_revision=state_revision+1 WHERE id=$1",
      [original.command.id, randomUUID()],
    );
    await Bun.sleep(2600);
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    await expect(readOrganizationPlanChangeSource(f.input)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
    });
    expect((await prepare(input)).command.status).toBe("PREPARED");
  }, 20000);
  test("original retained terms are tenant-bound and immutable after atomic quote save", async () => {
    const f = await seed();
    const row = (
      await db.query("SELECT * FROM organization_schedule_quote_terms WHERE quote_id=$1", [
        f.quote.id,
      ])
    ).rows[0];
    expect(row.organization_id).toBe(f.input.organizationId);
    expect(row.snapshot.subscription.id).toBe(f.source.stripe_subscription_id);
    expect(row.snapshot.customer.customerId).toBe(f.source.stripe_customer_id);
    expect(row.snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      db.query(
        "UPDATE organization_schedule_quote_terms SET snapshot_digest=$2 WHERE quote_id=$1",
        [f.quote.id, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("DELETE FROM organization_schedule_quote_terms WHERE quote_id=$1", [f.quote.id]),
    ).rejects.toMatchObject({ code: "23514" });
    const other = await seed();
    await expect(
      db.query(
        "UPDATE organization_schedule_quote_terms SET organization_id=$2 WHERE quote_id=$1",
        [f.quote.id, other.input.organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  test("a failing retained-term insertion rolls back its quote", async () => {
    const f = await seed();
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    const { saveOrganizationDowngradeQuote } = await import("./organization-downgrade-quotes");
    const before = (
      await db.query(
        "SELECT count(*)::int n FROM organization_plan_change_quotes WHERE organization_id=$1",
        [f.input.organizationId],
      )
    ).rows[0].n;
    await db.query(
      `CREATE FUNCTION reject_test_terms() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected binding failure' USING ERRCODE='23514'; END $$`,
    );
    await db.query(
      "CREATE TRIGGER test_terms_failure BEFORE INSERT ON organization_schedule_quote_terms FOR EACH ROW EXECUTE FUNCTION reject_test_terms()",
    );
    try {
      await expect(
        saveOrganizationDowngradeQuote({
          identity: f.input,
          captured: await readOrganizationPlanChangeSource(f.input),
          review: f.quote.review,
          providerBinding: f.quote.provider_binding!,
          retainedTerms: f.retainedTerms,
        }),
      ).rejects.toThrow();
    } finally {
      await db.query("DROP TRIGGER test_terms_failure ON organization_schedule_quote_terms");
      await db.query("DROP FUNCTION reject_test_terms()");
    }
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM organization_plan_change_quotes WHERE organization_id=$1",
          [f.input.organizationId],
        )
      ).rows[0].n,
    ).toBe(before);
  });
  test("fresh provider observations must match the original stored source and customer terms", async () => {
    const f = await seed();
    const { assertOrganizationScheduleQuoteTermsCurrent } = await import(
      "../../lib/services/organization-schedule-quote-terms"
    );
    const { scheduleCustomerTestObservation } = await import(
      "../../lib/services/organization-schedule-test-fixture"
    );
    const customer = scheduleCustomerTestObservation(f.source.stripe_customer_id);
    const args = {
      original: f.retainedTerms,
      rawSubscription: f.retainedTerms.subscription,
      rawCustomer: customer,
      observedAt: new Date(f.review.observedAt),
    };
    expect(assertOrganizationScheduleQuoteTermsCurrent(args)).toEqual(f.retainedTerms);
    expect(() =>
      assertOrganizationScheduleQuoteTermsCurrent({
        ...args,
        rawCustomer: { ...customer, balance: -100 },
      }),
    ).toThrow();
    expect(() =>
      assertOrganizationScheduleQuoteTermsCurrent({
        ...args,
        rawSubscription: { ...f.retainedTerms.subscription, default_payment_method: "pm_changed" },
      }),
    ).toThrow();
    const row = (
      await db.query("SELECT snapshot FROM organization_schedule_quote_terms WHERE quote_id=$1", [
        f.quote.id,
      ])
    ).rows[0];
    expect(row.snapshot).toEqual(f.retainedTerms);
  });
});
