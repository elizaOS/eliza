/**
 * Redeems subscription grant codes against the real subscription migrations
 * on PGlite, then reads the same organization policy and allowance
 * eligibility that inference admission uses, during and after the grant and
 * alongside a paid subscription.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

const PAID_ORG = "61000000-0000-4000-8000-000000000001";
const PAID_SUB = "62000000-0000-4000-8000-000000000001";
const USER = "63000000-0000-4000-8000-000000000001";
const PEPPER = "test-pepper-0123456789abcdef0123456789";
let orgCounter = 0;

let database: typeof import("../client");
let grants: typeof import("./subscription-grants");
let policyModule: typeof import("../../lib/services/organization-quota-policy");
let eligibility: typeof import("./subscription-allowance-eligibility");
let freeValues: typeof import("./subscription-entitlements");
let entitlementToken: typeof import("../../lib/services/subscription-entitlement-token");

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}
async function rows<T>(query: string): Promise<T[]> {
  return (await database.getPgliteClientForTests().query<T>(query)).rows;
}

async function newOrg(): Promise<string> {
  orgCounter += 1;
  const id = `64000000-0000-4000-8000-${String(orgCounter).padStart(12, "0")}`;
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${id}', '0', 1, 0, '{}', true, false, 'active')`);
  return id;
}

async function newCode(
  code: string,
  options: {
    max?: number;
    family?: string;
    expiresAt?: string;
    disabled?: boolean;
    days?: number | null;
    /** Calendar-month term; the code then has no day term. */
    months?: number;
    exclusive?: boolean;
  } = {},
): Promise<void> {
  const normalized = grants.normalizeSubscriptionGrantCode(code);
  if (!normalized) throw new Error(`bad test code ${code}`);
  const hash = await grants.hashSubscriptionGrantCode(normalized, PEPPER);
  const days =
    options.months !== undefined || options.days === null ? "NULL" : (options.days ?? 183);
  await exec(`INSERT INTO subscription_grant_codes(code_hash, family, max_redemptions, duration_days, duration_months, requires_no_paid_plan, expires_at, disabled_at)
    VALUES ('${hash}', '${options.family ?? "alpha_phone"}', ${options.max ?? 1}, ${days}, ${options.months ?? "NULL"}, ${options.exclusive === true},
      ${options.expiresAt ? `'${options.expiresAt}'` : "NULL"}, ${options.disabled ? "now()" : "NULL"})`);
}

async function redeem(
  organizationId: string,
  code: string,
  idempotencyKey = `key-${code.replace(/\W/g, "")}-${organizationId}`,
  userId: string = USER,
) {
  const normalized = grants.normalizeSubscriptionGrantCode(code);
  return grants.subscriptionGrantsRepository.redeem({
    organizationId,
    userId,
    codeHash: await grants.hashSubscriptionGrantCode(normalized ?? code, PEPPER),
    idempotencyKey,
  });
}

/** SET clause for the free values a terminal revision derives (source ids kept). */
function freeProjectionSql(): string {
  return Object.entries(freeValues.SUBSCRIPTION_FREE_ENTITLEMENT_VALUES)
    .filter(([column]) => !column.startsWith("source_"))
    .map(
      ([column, value]) =>
        `${column} = ${value === null ? "NULL" : typeof value === "string" ? `'${value}'` : String(value)}`,
    )
    .join(", ");
}

async function policyAt(organizationId: string, at?: Date) {
  return database.dbWrite.transaction((tx) =>
    policyModule.readOrganizationQuotaPolicyInTransaction(tx, organizationId, at),
  );
}

async function allowanceAt(organizationId: string, at: Date) {
  return database.dbWrite.transaction((tx) =>
    eligibility.readEligibleSubscriptionAllowance(tx, organizationId, at, false),
  );
}

beforeAll(async () => {
  database = await import("../client");
  await createBillingSnapshotFixture(exec, "");
  // Production state from 0404: subscription-grant (and trial) buckets carry no invoice.
  await exec(
    `ALTER TABLE subscription_allowance_periods ALTER COLUMN stripe_invoice_id DROP NOT NULL`,
  );
  await exec(`INSERT INTO users(id) VALUES ('${USER}')`);
  // Publish the fixture's paid Plus projection exactly as its lifecycle revision derives it.
  await exec(`UPDATE organization_entitlements SET completions_rpm = 120, embeddings_rpm = 200,
    standard_rpm = 60, strict_rpm = 10, entitlement_effective = true,
    effective_from = '2026-08-01Z', effective_until = '2026-09-01Z', catalog_version = 'v1',
    source_digest = '${"b".repeat(64)}' WHERE organization_id = '${PAID_ORG}'`);
  grants = await import("./subscription-grants");
  policyModule = await import("../../lib/services/organization-quota-policy");
  eligibility = await import("./subscription-allowance-eligibility");
  freeValues = await import("./subscription-entitlements");
  entitlementToken = await import("../../lib/services/subscription-entitlement-token");
});

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("subscription grant redemption", () => {
  test("a redeemed code serves the organization as an active Plus subscriber", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0001");
    const before = await policyAt(org);
    expect(before.authority.source).toBe("legacy");
    expect(before.subscriptionFunded).toBe(false);

    const { grant, replayed } = await redeem(org, "aaaa bbbb cccc 0001");
    expect(replayed).toBe(false);
    expect(grant.plan_key).toBe("plus_monthly");
    expect(grant.ends_at!.getTime() - grant.starts_at.getTime()).toBe(183 * 86_400_000);

    const [projection] = await rows<{
      plan_key: string;
      state: string;
      source_grant_id: string;
      completions_rpm: number;
    }>(
      `SELECT plan_key, state, source_grant_id, completions_rpm FROM organization_entitlements WHERE organization_id = '${org}' AND billing_scope_id IS NULL`,
    );
    expect(projection).toMatchObject({
      plan_key: "plus_monthly",
      state: "active",
      source_grant_id: grant.id,
      completions_rpm: 120,
    });

    const buckets = await rows<{ granted_amount: string; period_start: Date; period_end: Date }>(
      `SELECT granted_amount, period_start, period_end FROM subscription_allowance_periods WHERE promo_grant_id = '${grant.id}' ORDER BY period_start`,
    );
    expect(buckets.length).toBe(7);
    expect(buckets.slice(0, 6).every((bucket) => bucket.granted_amount === "25.000000")).toBe(true);
    expect(Number(buckets[6]!.granted_amount)).toBeGreaterThan(0);
    expect(Number(buckets[6]!.granted_amount)).toBeLessThan(25);
    expect(new Date(buckets[6]!.period_end).getTime()).toBe(grant.ends_at!.getTime());

    const during = await policyAt(org);
    expect(during.authority).toMatchObject({
      source: "promo_grant",
      sourceGrantId: grant.id,
      effectiveUntil: grant.ends_at!.toISOString(),
    });
    expect(during.authority.generation).not.toBe(before.authority.generation);
    expect(during.subscriptionFunded).toBe(true);
    expect(policyModule.requireOrganizationRateTier(during)).toMatchObject({
      tierName: "plus_monthly",
      completionsRpm: 120,
    });
    expect(during.limits.apiKeys).toEqual({
      status: "available",
      limit: 10n,
      source: "subscription-catalog",
    });
    const midGrant = new Date(grant.starts_at.getTime() + 40 * 86_400_000);
    const period = await allowanceAt(org, midGrant);
    expect(period?.promo_grant_id).toBe(grant.id);
    expect(period?.available_amount).toBe("25.000000");
  });

  test("admission reverts to the pay-as-you-go policy when the grant ends", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0002");
    const { grant } = await redeem(org, "AAAA-BBBB-CCCC-0002");
    const after = new Date(grant.ends_at!.getTime() + 1_000);
    const policy = await policyAt(org, after);
    expect(policy.authority.source).toBe("legacy");
    expect(policy.subscriptionFunded).toBe(false);
    expect(await allowanceAt(org, after)).toBeUndefined();
  });

  test("a replay returns the original grant; a second code of the family is refused", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0003", { max: 5 });
    await newCode("AAAA-BBBB-CCCC-0004", { max: 5 });
    await newCode("AAAA-BBBB-CCCC-0005", { max: 5, family: "other_campaign" });
    const first = await redeem(org, "AAAA-BBBB-CCCC-0003", "phone-attempt-1");
    const replay = await redeem(org, "AAAA-BBBB-CCCC-0003", "phone-attempt-2");
    expect(replay).toEqual({ grant: first.grant, replayed: true });
    const [{ redeemed_count }] = await rows<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM subscription_grant_codes c JOIN subscription_grants g ON g.code_id = c.id WHERE g.id = '${first.grant.id}'`,
    );
    expect(redeemed_count).toBe(1);
    await expect(redeem(org, "AAAA-BBBB-CCCC-0004")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_ALREADY_GRANTED,
    });
    await expect(redeem(org, "AAAA-BBBB-CCCC-0005", "phone-attempt-1")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_IDEMPOTENCY_CONFLICT,
    });
  });

  test("concurrent redemptions never exceed the limit or grant an organization twice", async () => {
    await newCode("AAAA-BBBB-CCCC-0006", { max: 2 });
    const orgs = await Promise.all([newOrg(), newOrg(), newOrg(), newOrg()]);
    const outcomes = await Promise.allSettled([
      ...orgs.map((org) => redeem(org, "AAAA-BBBB-CCCC-0006")),
      redeem(orgs[0]!, "AAAA-BBBB-CCCC-0006", "same-org-retry"),
    ]);
    const granted = outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && !outcome.value.replayed,
    );
    expect(granted).toHaveLength(2);
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(outcome.reason).toMatchObject({ code: grants.SUBSCRIPTION_GRANT_CODE_INVALID });
    const [{ redeemed_count, grants_count }] = await rows<{
      redeemed_count: number;
      grants_count: number;
    }>(
      `SELECT c.redeemed_count, (SELECT count(*)::int FROM subscription_grants g WHERE g.code_id = c.id) AS grants_count
       FROM subscription_grant_codes c WHERE c.max_redemptions = 2 AND c.family = 'alpha_phone' ORDER BY c.created_at DESC LIMIT 1`,
    );
    expect(redeemed_count).toBe(2);
    expect(grants_count).toBe(2);
    const perOrg = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM subscription_grants WHERE organization_id = '${orgs[0]}'`,
    );
    expect(perOrg[0]!.count).toBeLessThanOrEqual(1);
  });

  test("unknown, expired, disabled and exhausted codes share one refusal", async () => {
    await newCode("AAAA-BBBB-CCCC-0007", { expiresAt: "2020-01-01T00:00:00Z" });
    await newCode("AAAA-BBBB-CCCC-0008", { disabled: true });
    await newCode("AAAA-BBBB-CCCC-0009", { max: 1 });
    await redeem(await newOrg(), "AAAA-BBBB-CCCC-0009");
    for (const code of [
      "ZZZZ-ZZZZ-ZZZZ-ZZZZ",
      "AAAA-BBBB-CCCC-0007",
      "AAAA-BBBB-CCCC-0008",
      "AAAA-BBBB-CCCC-0009",
    ]) {
      const org = await newOrg();
      await expect(redeem(org, code)).rejects.toMatchObject({
        code: grants.SUBSCRIPTION_GRANT_CODE_INVALID,
      });
      const [{ count }] = await rows<{ count: number }>(
        `SELECT count(*)::int AS count FROM subscription_allowance_periods WHERE organization_id = '${org}'`,
      );
      expect(count).toBe(0);
    }
  });

  test("an effective paid subscription keeps precedence; the grant serves after it lapses", async () => {
    await newCode("AAAA-BBBB-CCCC-0010");
    const { grant } = await redeem(PAID_ORG, "AAAA-BBBB-CCCC-0010");
    // The paid projection is not replaced by the grant.
    const [projection] = await rows<{
      source_subscription_id: string;
      source_grant_id: string | null;
    }>(
      `SELECT source_subscription_id, source_grant_id FROM organization_entitlements WHERE organization_id = '${PAID_ORG}' AND billing_scope_id IS NULL`,
    );
    expect(projection).toEqual({ source_subscription_id: PAID_SUB, source_grant_id: null });

    // While the paid period is current, the paid subscription and its bucket serve.
    const paidTime = new Date("2026-08-15T00:00:00Z");
    const paid = await policyAt(PAID_ORG, paidTime);
    expect(paid.authority.source).toBe("subscription");
    expect((await allowanceAt(PAID_ORG, paidTime))?.subscription_id).toBe(PAID_SUB);

    // The fixture's paid period ended in September; now the grant serves.
    const now = new Date(grant.starts_at.getTime() + 60_000);
    const lapsed = await policyAt(PAID_ORG, now);
    expect(lapsed.authority).toMatchObject({ source: "promo_grant", sourceGrantId: grant.id });
    expect(lapsed.subscriptionFunded).toBe(true);
    expect((await allowanceAt(PAID_ORG, now))?.promo_grant_id).toBe(grant.id);

    const { readPrimaryOrganizationSubscription } = await import(
      "./account-billing-snapshot-subscription"
    );
    const { buildSubscriptionGrantSnapshot } = await import(
      "../../lib/services/account-subscription-snapshot"
    );
    const primary = await database.dbWrite.transaction((tx) =>
      readPrimaryOrganizationSubscription(tx, PAID_ORG),
    );
    if (primary.state !== "current") throw new Error("Expected paid fixture source");
    const observation = await database.dbWrite.transaction((tx) =>
      grants.readSubscriptionGrantObservation(tx, PAID_ORG, now),
    );
    // Move the observed subscription boundary relative to the grant's real
    // observation clock; each projection retains the full database-read source.
    const end = new Date(now.getTime() - 86_400_000);
    const active = {
      ...primary,
      subscription: { ...primary.subscription, current_period_end: end },
      entitlement: { ...primary.entitlement, effective_until: end },
    };
    expect(buildSubscriptionGrantSnapshot(observation, active, now.toISOString())).toMatchObject({
      status: "available",
      value: { paidPlanTakesPrecedence: true },
    });
    expect(
      buildSubscriptionGrantSnapshot(
        observation,
        active,
        new Date(end.getTime() + 3 * 86_400_000).toISOString(),
      ),
    ).toMatchObject({
      status: "available",
      value: { paidPlanTakesPrecedence: false },
    });
    const graceEnd = new Date(now.getTime() + 86_400_000);
    const grace = {
      ...active,
      subscription: {
        ...active.subscription,
        status: "grace" as const,
        grace_expires_at: graceEnd,
      },
      entitlement: { ...active.entitlement, state: "grace" as const, effective_until: graceEnd },
    };
    expect(buildSubscriptionGrantSnapshot(observation, grace, now.toISOString())).toMatchObject({
      status: "available",
      value: { paidPlanTakesPrecedence: true },
    });
    expect(
      buildSubscriptionGrantSnapshot(observation, grace, graceEnd.toISOString()),
    ).toMatchObject({
      status: "available",
      value: { paidPlanTakesPrecedence: false },
    });
    expect(
      buildSubscriptionGrantSnapshot(
        observation,
        { state: "unavailable", code: "subscription_authority_unavailable" },
        now.toISOString(),
      ),
    ).toMatchObject({
      status: "unavailable",
      error: { code: "subscription_authority_unavailable" },
    });
  });

  test("an exclusive code is refused while the organization has an open paid subscription", async () => {
    // PAID_ORG's organization subscription is still `active` here (the next
    // tests move it to terminal states).
    await newCode("PILT-AAAA-BBBB-0001", { family: "grace_pilot", months: 6, exclusive: true });
    await expect(redeem(PAID_ORG, "PILT-AAAA-BBBB-0001")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE,
    });
    const [held] = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM subscription_grants WHERE organization_id = '${PAID_ORG}' AND family = 'grace_pilot'`,
    );
    expect(held!.count).toBe(0);
    const [code] = await rows<{ redeemed_count: number }>(
      `SELECT c.redeemed_count FROM subscription_grant_codes c WHERE c.family = 'grace_pilot' AND c.duration_months = 6 AND c.max_redemptions = 1 ORDER BY c.created_at DESC LIMIT 1`,
    );
    expect(code!.redeemed_count).toBe(0);
  });

  for (const [revision, status] of [
    [2, "canceled"],
    [3, "incomplete_expired"],
  ] as const)
    test(`a ${status} subscription (projected as free) is served by the active grant`, async () => {
      // The subscription ends during the grant window: the projection becomes
      // the free values a terminal revision derives.
      await exec(`INSERT INTO billing_subscription_revisions(organization_id, subscription_id, revision, source, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, cancel_at_period_end, ended_at, provider_object_digest)
        VALUES('${PAID_ORG}', '${PAID_SUB}', ${revision}, 'webhook', 'test', 'cus_snapshot', 'sub_snapshot', 'si_snapshot', 'plus_monthly', 'v1', '${status}', '2026-08-01Z', '2026-09-01Z', false, '2026-09-01Z', '${"c".repeat(64)}');
        UPDATE billing_subscriptions SET status = '${status}', lifecycle_revision = ${revision}, provider_object_digest = '${"c".repeat(64)}' WHERE id = '${PAID_SUB}';
        UPDATE organization_entitlements SET ${freeProjectionSql()}, effective_from = '2026-09-01Z',
          source_subscription_revision = ${revision}, source_digest = '${"c".repeat(64)}',
          projection_revision = projection_revision + 1
        WHERE organization_id = '${PAID_ORG}' AND billing_scope_id IS NULL;`);
      const [grant] = await rows<{ id: string; starts_at: Date }>(
        `SELECT id, starts_at FROM subscription_grants WHERE organization_id = '${PAID_ORG}'`,
      );
      const policy = await policyAt(PAID_ORG);
      expect(policy.authority).toMatchObject({ source: "promo_grant", sourceGrantId: grant!.id });
      expect(policy.subscriptionFunded).toBe(true);
      expect(policyModule.requireOrganizationRateTier(policy).tierName).toBe("plus_monthly");
      expect((await allowanceAt(PAID_ORG, new Date()))?.promo_grant_id).toBe(grant!.id);
      const summary = await entitlementToken.readOrganizationEntitlementSummary(PAID_ORG, {
        allowance: true,
      });
      expect(summary).toMatchObject({
        source: "grant",
        plan: { id: "plus_monthly", status: "active" },
        rateTier: "plus_monthly",
      });
      // The token reports the grant's own allowance bucket in micro-dollars.
      const bucket = (await allowanceAt(PAID_ORG, new Date()))!;
      const micros = (value: string) => Math.round(Number(value) * 1_000_000);
      expect(summary.allowance).toEqual({
        unit: "usd_micros",
        granted: micros(bucket.granted_amount) + micros(bucket.adjustment_amount),
        remaining: micros(bucket.available_amount),
        periodStart: bucket.period_start,
        resetsAt: bucket.expires_at,
      });
      expect(summary.allowance!.granted).toBeGreaterThan(0);
    });

  test("revoking the grant of a canceled subscriber serves the free plan", async () => {
    const [grant] = await rows<{ id: string }>(
      `SELECT id FROM subscription_grants WHERE organization_id = '${PAID_ORG}'`,
    );
    await grants.subscriptionGrantsRepository.revoke({ grantId: grant!.id, reason: "support" });
    const policy = await policyAt(PAID_ORG);
    expect(policy.authority.source).toBe("subscription");
    expect(policy.subscriptionFunded).toBe(false);
    expect(await allowanceAt(PAID_ORG, new Date())).toBeUndefined();
    expect((await entitlementToken.readOrganizationEntitlementSummary(PAID_ORG)).plan.status).toBe(
      "canceled",
    );
  });
});

describe("subscription grant code validity before family checks", () => {
  test("an organization holding a grant gets the generic refusal for a code that is not redeemable", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0011");
    await newCode("AAAA-BBBB-CCCC-0012", { disabled: true });
    await newCode("AAAA-BBBB-CCCC-0013", { expiresAt: "2020-01-01T00:00:00Z" });
    await newCode("AAAA-BBBB-CCCC-0014", { max: 2 });
    await redeem(org, "AAAA-BBBB-CCCC-0011");
    for (const code of ["AAAA-BBBB-CCCC-0012", "AAAA-BBBB-CCCC-0013", "ZZZZ-ZZZZ-ZZZZ-ZZZY"])
      await expect(redeem(org, code)).rejects.toMatchObject({
        code: grants.SUBSCRIPTION_GRANT_CODE_INVALID,
      });
    // Only a redeemable code reaches the family answer.
    await expect(redeem(org, "AAAA-BBBB-CCCC-0014")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_ALREADY_GRANTED,
    });
  });
});

describe("subscription grant records and account deletion", () => {
  test("deleting the redeeming user keeps the grant and clears its user", async () => {
    const user = "63000000-0000-4000-8000-000000000099";
    await exec(`INSERT INTO users(id) VALUES ('${user}')`);
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0021");
    const { grant } = await redeem(org, "AAAA-BBBB-CCCC-0021", undefined, user);
    expect(grant.user_id).toBe(user);
    await exec(`DELETE FROM users WHERE id = '${user}'`);
    const [kept] = await rows<{ user_id: string | null; ends_at: Date }>(
      `SELECT user_id, ends_at FROM subscription_grants WHERE id = '${grant.id}'`,
    );
    expect(kept!.user_id).toBeNull();
    expect(new Date(kept!.ends_at).getTime()).toBe(grant.ends_at!.getTime());
    // The organization keeps its grant service after the user is gone.
    expect((await policyAt(org)).authority.source).toBe("promo_grant");
  });

  test("grant terms stay immutable and grant rows cannot be deleted", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0022");
    const { grant } = await redeem(org, "AAAA-BBBB-CCCC-0022");
    await expect(
      exec(
        `UPDATE subscription_grants SET ends_at = ends_at + interval '1 day' WHERE id = '${grant.id}'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      exec(`UPDATE subscription_grants SET user_id = '${PAID_ORG}' WHERE id = '${grant.id}'`),
    ).rejects.toThrow();
    await expect(exec(`DELETE FROM subscription_grants WHERE id = '${grant.id}'`)).rejects.toThrow(
      /cannot be deleted/,
    );
  });
});

describe("subscription grant revocation", () => {
  test("a revoked grant stops serving at once and its buckets are retired", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0031", { max: 3 });
    await newCode("AAAA-BBBB-CCCC-0032", { max: 3 });
    const { grant } = await redeem(org, "AAAA-BBBB-CCCC-0031");
    const during = await policyAt(org);
    expect(during.authority.source).toBe("promo_grant");

    const result = await grants.subscriptionGrantsRepository.revoke({
      grantId: grant.id,
      reason: "leaked batch",
    });
    expect(result.revoked).toBe(true);
    expect(result.retiredPeriods).toBe(7);
    expect(result.grant.revoked_at).not.toBeNull();

    const after = await policyAt(org);
    expect(after.authority.source).toBe("legacy");
    expect(after.subscriptionFunded).toBe(false);
    expect(after.authority.generation).not.toBe(during.authority.generation);
    expect(await allowanceAt(org, new Date())).toBeUndefined();
    const [projection] = await rows<{
      plan_key: string;
      state: string;
      source_grant_id: string | null;
    }>(
      `SELECT plan_key, state, source_grant_id FROM organization_entitlements WHERE organization_id = '${org}' AND billing_scope_id IS NULL`,
    );
    expect(projection).toEqual({ plan_key: "free", state: "free", source_grant_id: null });
    const open = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM subscription_allowance_periods WHERE promo_grant_id = '${grant.id}' AND state = 'open'`,
    );
    expect(open[0]!.count).toBe(0);
    const summary = await entitlementToken.readOrganizationEntitlementSummary(org);
    expect(summary.plan.status).toBe("none");

    // Revoking again is a no-op; a revoked grant keeps the family slot; a
    // replay of the same code reports the revoked grant.
    expect(
      (await grants.subscriptionGrantsRepository.revoke({ grantId: grant.id, reason: "again" }))
        .revoked,
    ).toBe(false);
    await expect(redeem(org, "AAAA-BBBB-CCCC-0032")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_ALREADY_GRANTED,
    });
    const replay = await redeem(org, "AAAA-BBBB-CCCC-0031");
    expect(replay.replayed).toBe(true);
    expect(replay.grant.revoked_at).not.toBeNull();
    // Revocation is one way.
    await expect(
      exec(
        `UPDATE subscription_grants SET revoked_at = NULL, revoked_reason = NULL WHERE id = '${grant.id}'`,
      ),
    ).rejects.toThrow(/immutable/);
  });

  test("an unknown grant id is a typed error", async () => {
    await expect(
      grants.subscriptionGrantsRepository.revoke({
        grantId: "65000000-0000-4000-8000-000000000000",
        reason: "test",
      }),
    ).rejects.toMatchObject({ code: grants.SUBSCRIPTION_GRANT_NOT_FOUND });
  });
});

describe("grant allowance schedule", () => {
  test("splits a window into calendar months and prorates the remainder", () => {
    const schedule = grants.grantAllowanceSchedule(
      new Date("2026-01-31T00:00:00Z"),
      new Date("2026-04-15T00:00:00Z"),
      "25.000000",
    );
    expect(schedule.map((bucket) => bucket.periodStart.toISOString())).toEqual([
      "2026-01-31T00:00:00.000Z",
      "2026-02-28T00:00:00.000Z",
      "2026-03-31T00:00:00.000Z",
    ]);
    expect(schedule.map((bucket) => bucket.amount)).toEqual([
      "25.000000",
      "25.000000",
      expect.stringMatching(/^1[12]\.\d{6}$/),
    ]);
  });
});

test("a lifetime grant publishes no expiry and retains revocation", async () => {
  const org = await newOrg();
  await newCode("LIFE-AAAA-BBBB-0001", { days: null });
  const { grant } = await redeem(org, "LIFE-AAAA-BBBB-0001");
  expect(grant.ends_at).toBeNull();
  const farFuture = new Date(grant.starts_at);
  farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 100);
  const policy = await policyAt(org, farFuture);
  expect(policy.authority.source).toBe("promo_grant");
  expect(policy.authority.effectiveUntil).toBeNull();
  expect(policy.subscriptionFunded).toBe(true);
  const buckets = await rows<{ count: number }>(
    `SELECT count(*)::integer count FROM subscription_allowance_periods WHERE promo_grant_id = '${grant.id}'`,
  );
  expect(buckets[0]?.count).toBe(3);
  expect(await grants.subscriptionGrantsRepository.replenishLifetimeAllowances()).toBe(0);
  await grants.subscriptionGrantsRepository.revoke({
    grantId: grant.id,
    reason: "test revocation",
  });
  expect((await policyAt(org)).authority.source).toBe("legacy");
  expect(await grants.subscriptionGrantsRepository.replenishLifetimeAllowances()).toBe(0);
});

test("lifetime replenishment skips missed months and replays without double credit", async () => {
  const org = await newOrg();
  await newCode("LIFE-AAAA-BBBB-0002", { days: null });
  const hash = await grants.hashSubscriptionGrantCode(
    grants.normalizeSubscriptionGrantCode("LIFE-AAAA-BBBB-0002")!,
    PEPPER,
  );
  const [grant] = await rows<{
    id: string;
  }>(`INSERT INTO subscription_grants(organization_id,user_id,code_id,family,plan_key,catalog_version,idempotency_key,starts_at,ends_at)
    SELECT '${org}', '${USER}', id, family, plan_key, catalog_version, 'historical-lifetime-grant', now() - interval '2 years', NULL
    FROM subscription_grant_codes WHERE code_hash = '${hash}' RETURNING id`);
  expect(grant).toBeDefined();
  expect(await grants.subscriptionGrantsRepository.replenishLifetimeAllowances()).toBe(3);
  expect(await grants.subscriptionGrantsRepository.replenishLifetimeAllowances()).toBe(0);
  const buckets = await rows<{
    count: number;
    current: number;
    ledger: number;
  }>(`SELECT count(*)::integer count,
    count(*) FILTER (WHERE period_start <= now() AND period_end > now())::integer current,
    (SELECT count(*)::integer FROM subscription_allowance_transactions WHERE metadata->>'promoGrantId' = '${grant!.id}') ledger
    FROM subscription_allowance_periods WHERE promo_grant_id = '${grant!.id}'`);
  expect(buckets[0]).toEqual({ count: 3, current: 1, ledger: 3 });
});

describe("calendar-month pilot terms", () => {
  test("UTC calendar months clamp month ends, including leap years", () => {
    const at = (iso: string) => grants.addUtcMonths(new Date(iso), 6).toISOString();
    expect(at("2026-01-31T10:15:00.000Z")).toBe("2026-07-31T10:15:00.000Z");
    expect(at("2026-08-31T23:59:59.999Z")).toBe("2027-02-28T23:59:59.999Z");
    expect(at("2027-08-31T00:00:00.000Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(at("2027-08-29T12:00:00.000Z")).toBe("2028-02-29T12:00:00.000Z");
    expect(at("2026-12-31T00:00:00.000Z")).toBe("2027-06-30T00:00:00.000Z");
    expect(at("2026-10-15T00:00:00.000Z")).toBe("2027-04-15T00:00:00.000Z");
    expect(
      grants
        .grantEndsAt({ duration_days: null, duration_months: 6 }, new Date("2028-02-29T00:00:00Z"))
        ?.toISOString(),
    ).toBe("2028-08-29T00:00:00.000Z");
    expect(
      grants.grantEndsAt({ duration_days: 183, duration_months: null }, new Date(0))?.getTime(),
    ).toBe(183 * 86_400_000);
    expect(grants.grantEndsAt({ duration_days: null, duration_months: null }, new Date(0))).toBe(
      null,
    );
  });

  test("a six-month code grants six full allowance months ending on the calendar date", async () => {
    const org = await newOrg();
    await newCode("PILT-AAAA-BBBB-0002", { family: "grace_pilot", months: 6, exclusive: true });
    const { grant, replayed } = await redeem(org, "PILT-AAAA-BBBB-0002", "tablet-attempt-1");
    expect(replayed).toBe(false);
    expect(grant.ends_at!.toISOString()).toBe(
      grants.addUtcMonths(grant.starts_at, 6).toISOString(),
    );
    const buckets = await rows<{ granted_amount: string; period_end: Date }>(
      `SELECT granted_amount, period_end FROM subscription_allowance_periods WHERE promo_grant_id = '${grant.id}' ORDER BY period_start`,
    );
    expect(buckets.map((bucket) => bucket.granted_amount)).toEqual(Array(6).fill("25.000000"));
    expect(new Date(buckets[5]!.period_end).getTime()).toBe(grant.ends_at!.getTime());

    // A retry from another device replays the same dates; the code cannot be
    // stacked or used to reset the expiry.
    const replay = await redeem(org, "PILT-AAAA-BBBB-0002", "tablet-attempt-2");
    expect(replay.replayed).toBe(true);
    expect(replay.grant.id).toBe(grant.id);
    expect(replay.grant.ends_at!.getTime()).toBe(grant.ends_at!.getTime());
    await newCode("PILT-AAAA-BBBB-0003", { family: "grace_pilot", months: 6, exclusive: true });
    await expect(redeem(org, "PILT-AAAA-BBBB-0003")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_ALREADY_GRANTED,
    });
  });

  test("an unknown subscription authority refuses an exclusive code", async () => {
    const org = await newOrg();
    await exec(
      `UPDATE organization_subscription_authorities SET state = 'unavailable' WHERE organization_id = '${org}'`,
    );
    await newCode("PILT-AAAA-BBBB-0004", { family: "grace_pilot", months: 6, exclusive: true });
    await expect(redeem(org, "PILT-AAAA-BBBB-0004")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE,
    });
  });

  test("a code cannot carry both a day and a month term", async () => {
    await expect(
      exec(`INSERT INTO subscription_grant_codes(code_hash, family, max_redemptions, duration_days, duration_months)
        VALUES ('${"e".repeat(64)}', 'grace_pilot', 1, 183, 6)`),
    ).rejects.toThrow(/single_term/);
    await expect(
      exec(`INSERT INTO subscription_grant_codes(code_hash, family, max_redemptions, duration_days, duration_months)
        VALUES ('${"f".repeat(64)}', 'grace_pilot', 1, NULL, 0)`),
    ).rejects.toThrow();
  });
});

describe("subscription grant readback", () => {
  test("the account snapshot reports the grant's free-through date and current allowance", async () => {
    const snapshotModule = await import("../../lib/services/account-subscription-snapshot");
    const org = await newOrg();
    await newCode("PILT-AAAA-BBBB-0005", { family: "grace_pilot", months: 6, exclusive: true });
    const { grant } = await redeem(org, "PILT-AAAA-BBBB-0005");
    const at = new Date(grant.starts_at.getTime() + 45 * 86_400_000);
    const observation = await database.dbWrite.transaction((tx) =>
      grants.readSubscriptionGrantObservation(tx, org, at),
    );
    expect(observation?.grant.id).toBe(grant.id);
    const projected = snapshotModule.buildSubscriptionGrantSnapshot(
      observation,
      { state: "none" } as never,
      at.toISOString(),
    );
    expect(projected).toMatchObject({
      status: "available",
      value: {
        grantId: grant.id,
        planKey: "plus_monthly",
        startsAt: grant.starts_at.toISOString(),
        endsAt: grant.ends_at!.toISOString(),
        paidPlanTakesPrecedence: false,
        allowance: {
          status: "available",
          value: {
            periodStart: grants.addUtcMonths(grant.starts_at, 1).toISOString(),
            periodEnd: grants.addUtcMonths(grant.starts_at, 2).toISOString(),
            state: "open",
            granted: "25.000000",
            unreserved: "25.000000",
            currency: "USD",
          },
        },
      },
    });

    // After the window, and after revocation, nothing is reported as active.
    const after = new Date(grant.ends_at!.getTime() + 1);
    expect(
      await database.dbWrite.transaction((tx) =>
        grants.readSubscriptionGrantObservation(tx, org, after),
      ),
    ).toBeNull();
    await grants.subscriptionGrantsRepository.revoke({ grantId: grant.id, reason: "pilot ended" });
    const revoked = await database.dbWrite.transaction((tx) =>
      grants.readSubscriptionGrantObservation(tx, org, at),
    );
    expect(revoked).toBeNull();
    expect(
      snapshotModule.buildSubscriptionGrantSnapshot(
        revoked,
        { state: "none" } as never,
        at.toISOString(),
      ),
    ).toMatchObject({ status: "not_applicable", reason: "no_active_subscription_grant" });
  });
});
