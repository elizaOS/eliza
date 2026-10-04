/** Exercises real migrated quote persistence; provider terms are controlled, no external effect. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  seedOrganizationUpgradeTestAccount as fixture,
  installOrganizationUpgradeTestSchema,
} from "./organization-upgrade-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
let client: typeof import("../client");
let quotes: typeof import("./organization-upgrade-quotes");
beforeAll(async () => {
  client = await import("../client");
  await installOrganizationUpgradeTestSchema((q) => client.getPgliteClientForTests().exec(q));
  quotes = await import("./organization-upgrade-quotes");
}, 120_000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

test("persists and rereads exact terms without creating a command", async () => {
  const f = await fixture();
  const quote = await quotes.saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    providerBinding: f.providerBinding,
    review: f.review,
  });
  await expect(
    client
      .getPgliteClientForTests()
      .query("DELETE FROM organization_plan_change_quotes WHERE id=$1", [quote.id]),
  ).rejects.toThrow();
  expect((await quotes.readOrganizationUpgradeQuote(f.input, quote.id)).review).toEqual(f.review);
  const rows = await client
    .getPgliteClientForTests()
    .query("SELECT id FROM billing_subscription_commands WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
  expect(rows.rows).toHaveLength(0);
});
test("quote id cannot transfer actor or organization authority", async () => {
  const f = await fixture(),
    other = await fixture();
  const quote = await quotes.saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    providerBinding: f.providerBinding,
    review: f.review,
  });
  await expect(quotes.readOrganizationUpgradeQuote(other.input, quote.id)).rejects.toThrow();
  await expect(
    quotes.readOrganizationUpgradeQuote({ ...f.input, actorId: other.input.actorId }, quote.id),
  ).rejects.toThrow();
});
test("changed source after provider review and invented allowance are rejected", async () => {
  const f = await fixture();
  await expect(
    quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: { ...f.review, additionalAllowanceUsd: "65.000000" },
    }),
  ).rejects.toThrow();
  await client
    .getPgliteClientForTests()
    .query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
  await expect(
    quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: f.review,
    }),
  ).rejects.toThrow();
});
test("database rejects changed terms and foreign-subscription transplants", async () => {
  const f = await fixture(),
    other = await fixture();
  const quote = await quotes.saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    providerBinding: f.providerBinding,
    review: f.review,
  });
  await expect(
    client
      .getPgliteClientForTests()
      .query(
        "UPDATE organization_plan_change_quotes SET review=jsonb_set(review,'{dueNow,amountDueCents}','1'::jsonb) WHERE id=$1",
        [quote.id],
      ),
  ).rejects.toThrow();
  await expect(
    client
      .getPgliteClientForTests()
      .query("UPDATE organization_plan_change_quotes SET subscription_id=$2 WHERE id=$1", [
        quote.id,
        other.input.subscriptionId,
      ]),
  ).rejects.toThrow();
  await expect(
    client
      .getPgliteClientForTests()
      .query("DELETE FROM organization_plan_change_quotes WHERE id=$1", [quote.id]),
  ).rejects.toThrow();
  expect((await quotes.readOrganizationUpgradeQuote(f.input, quote.id)).review).toEqual(f.review);
});

test("only an exact prepared upgrade can consume the quote, once", async () => {
  const f = await fixture();
  const quote = await quotes.saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    providerBinding: f.providerBinding,
    review: f.review,
  });
  const db = client.getPgliteClientForTests();
  const commands = await db.query<{ id: string }>(
    `INSERT INTO billing_subscription_commands(organization_id,requested_by_user_id,subscription_id,kind,target_plan_key,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest) VALUES($1,$2,$3,'upgrade','pro_monthly',1,$4,$4,$5) RETURNING id`,
    [
      f.input.organizationId,
      f.input.actorId,
      f.input.subscriptionId,
      crypto.randomUUID(),
      "a".repeat(64),
    ],
  );
  const id = commands.rows[0]!.id;
  await db.query(
    "UPDATE organization_plan_change_quotes SET consumed_by_command_id=$2,consumed_at=clock_timestamp() WHERE id=$1",
    [quote.id, id],
  );
  await expect(quotes.readOrganizationUpgradeQuote(f.input, quote.id)).rejects.toThrow();
  await expect(
    db.query(
      "UPDATE organization_plan_change_quotes SET consumed_by_command_id=NULL,consumed_at=NULL WHERE id=$1",
      [quote.id],
    ),
  ).rejects.toThrow();
});

test("expired provider review cannot be saved even with unchanged authority", async () => {
  const f = await fixture();
  const observed = new Date(Date.now() - 61_000);
  const prorationDate = Math.floor(observed.getTime() / 1000);
  const { proratedAllowanceIncrease } = await import(
    "../../lib/services/subscription-allowance-proration"
  );
  const review = {
    ...f.review,
    observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + 60_000).toISOString(),
    prorationDate,
    additionalAllowanceUsd: proratedAllowanceIncrease({
      previousUsd: "25.000000",
      targetUsd: "90.000000",
      periodStartMs: f.source.current_period_start.getTime(),
      periodEndMs: f.source.current_period_end.getTime(),
      effectiveAtMs: prorationDate * 1000,
    }),
  };
  await expect(
    quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review,
    }),
  ).rejects.toThrow();
});

test("provider binding is immutable and cannot contain credential-shaped extra fields", async () => {
  const f = await fixture();
  const quote = await quotes.saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    review: f.review,
    providerBinding: f.providerBinding,
  });
  expect(quote.provider_binding).toEqual(f.providerBinding);
  const db = client.getPgliteClientForTests();
  await expect(
    db.query(
      "UPDATE organization_plan_change_quotes SET provider_binding=jsonb_set(provider_binding,'{targetPriceId}','\"price_changed\"') WHERE id=$1",
      [quote.id],
    ),
  ).rejects.toThrow();
  await expect(
    quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      review: f.review,
      providerBinding: { ...f.providerBinding, livemode: true },
    }),
  ).rejects.toThrow();
  await expect(
    db.query(
      `INSERT INTO organization_plan_change_quotes(organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,created_at,expires_at,provider_binding)
 SELECT organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,created_at,expires_at,provider_binding||'{"credential":"synthetic"}'::jsonb FROM organization_plan_change_quotes WHERE id=$1`,
      [quote.id],
    ),
  ).rejects.toThrow();
  await expect(
    db.query(
      `INSERT INTO organization_plan_change_quotes(organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,created_at,expires_at)
 SELECT organization_id,actor_id,subscription_id,subscription_revision,target_plan_key,catalog_version,source_digest,review_digest,review,created_at,expires_at FROM organization_plan_change_quotes WHERE id=$1`,
      [quote.id],
    ),
  ).rejects.toThrow();
});
