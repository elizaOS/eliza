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
async function seed() {
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
    expiresAt: new Date(now.getTime() + 60000).toISOString(),
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
});
