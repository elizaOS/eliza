/** Actual PostgreSQL migration and quote authority; no provider mutations. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { OrganizationDowngradeReview } from "../../lib/services/organization-downgrade-review";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";
import { seedCancellationTestAccount } from "./subscription-cancellation-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `lower_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function seed(validityMs = 60000) {
  const f = await seedCancellationTestAccount((q, v) => db.query(q, v), undefined, "pro_monthly");
  const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
  const captured = await readOrganizationPlanChangeSource(f.input);
  const now = new Date();
  const review: OrganizationDowngradeReview = {
    kind: "downgrade_estimate",
    subscriptionId: f.input.subscriptionId,
    expectedSubscriptionRevision: "1",
    sourcePlanKey: "pro_monthly",
    targetPlanKey: "plus_monthly",
    catalogVersion: "v1",
    currency: "usd",
    currentPeriodStart: f.source.current_period_start.toISOString(),
    currentPeriodEnd: f.source.current_period_end.toISOString(),
    effectiveAt: f.source.current_period_end.toISOString(),
    amountDueNowCents: 0,
    targetBaseAmountCents: 3000,
    targetAllowanceUsd: "25.000000",
    recurringEstimate: {
      amountDueCents: 3000,
      subtotalCents: 3000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 3000,
      startingBalanceCents: 0,
    },
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + validityMs).toISOString(),
  };
  const { saveOrganizationDowngradeQuote } = await import("./organization-downgrade-quotes");
  const quote = await saveOrganizationDowngradeQuote({
    identity: f.input,
    captured,
    review,
    providerBinding: {
      sourcePriceId: "price_pro",
      targetPriceId: "price_plus",
      sourceProductId: "prod_pro",
      targetProductId: "prod_plus",
      livemode: false,
      apiVersion: "2024-11-20.acacia",
    },
  });
  return { ...f, quote };
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
});
