/**
 * Redeems Cloud-native subscription grant codes. One primary transaction locks
 * the organization, then the code row, so concurrent redemptions can neither
 * exceed a code's redemption limit nor grant one organization twice. A grant
 * publishes the plan's rate and resource policy for its window, through the
 * existing organization entitlement projection (organizations without a Stripe
 * subscription) and non-rollover monthly allowance buckets. A paid
 * subscription keeps precedence while it is effective.
 */
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { isProductionDeployment } from "../../lib/config/deployment-environment";
import { getCloudAwareEnv } from "../../lib/runtime/cloud-bindings";
import { ensureInferencePolicyMutation } from "../../lib/services/inference-policy-fence";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import {
  type OrganizationEntitlement,
  organizationEntitlements,
} from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import {
  type SubscriptionAllowancePeriod,
  subscriptionAllowancePeriods,
} from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import {
  type SubscriptionGrant,
  subscriptionGrantCodes,
  subscriptionGrants,
} from "../schemas/subscription-grants";
import { advanceOrganizationPolicyGeneration } from "./organization-policy-generation";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import { subscriptionAllowanceRepository } from "./subscription-allowance";
import { SUBSCRIPTION_FREE_ENTITLEMENT_VALUES } from "./subscription-entitlements";
import { microsToMoney, moneyToMicros } from "./subscription-funding-reservations";

/** Unknown, expired, disabled and fully redeemed codes share one answer. */
export const SUBSCRIPTION_GRANT_CODE_INVALID = "SUBSCRIPTION_GRANT_CODE_INVALID";
/** The organization already holds a grant from another code of the same family. */
export const SUBSCRIPTION_GRANT_ALREADY_GRANTED = "SUBSCRIPTION_GRANT_ALREADY_GRANTED";
/** The idempotency key already recorded a different redemption for this organization. */
export const SUBSCRIPTION_GRANT_IDEMPOTENCY_CONFLICT = "SUBSCRIPTION_GRANT_IDEMPOTENCY_CONFLICT";
/** An exclusive code was offered to an organization with an open (or unknown) paid subscription. */
export const SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE = "SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE";
/** No grant has the requested id. */
export const SUBSCRIPTION_GRANT_NOT_FOUND = "SUBSCRIPTION_GRANT_NOT_FOUND";
/** Minted codes are 16 Crockford base32 characters (80 bits); shorter text is never a code. */
export const SUBSCRIPTION_GRANT_CODE_MIN_LENGTH = 16;

const DAY_MS = 86_400_000;

export interface RedeemSubscriptionGrantInput {
  organizationId: string;
  userId: string | null;
  codeHash: string;
  idempotencyKey: string;
}

export interface RedeemSubscriptionGrantResult {
  grant: SubscriptionGrant;
  replayed: boolean;
}

function grantError(code: string, message: string, context: Record<string, unknown> = {}): never {
  throw new ElizaError(message, { code, context });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical code text: case, spaces and dashes are presentation only, so
 * `abcd-efgh` and `ABCD EFGH` are the same code. Crockford base32 read
 * aliases apply (O is 0; I and L are 1); minted codes never contain those
 * letters. Returns null for text that cannot be a code, so callers answer
 * with the same generic refusal.
 */
export function normalizeSubscriptionGrantCode(code: string): string | null {
  const normalized = code
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return new RegExp(`^[A-Z0-9]{${SUBSCRIPTION_GRANT_CODE_MIN_LENGTH},64}$`).test(normalized)
    ? normalized
    : null;
}

/** HMAC-SHA256 of the normalized code under the server pepper, as lowercase hex. */
export async function hashSubscriptionGrantCode(
  normalizedCode: string,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalizedCode));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** UTC calendar-month addition; a day past the target month's end clamps to its last day. */
export function addUtcMonths(start: Date, months: number): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(start.getUTCDate(), lastDay),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}

/**
 * Monthly, non-rollover buckets covering the grant window. Each full month
 * carries the plan's monthly allowance; a final partial month is prorated.
 */
export function grantAllowanceSchedule(
  startsAt: Date,
  endsAt: Date,
  monthlyAmountUsd: string,
): Array<{ periodStart: Date; periodEnd: Date; amount: string }> {
  const monthly = moneyToMicros(monthlyAmountUsd, "plan.allowance.amountUsd");
  const schedule: Array<{ periodStart: Date; periodEnd: Date; amount: string }> = [];
  for (let index = 0; ; index += 1) {
    const periodStart = addUtcMonths(startsAt, index);
    if (periodStart >= endsAt) break;
    const fullEnd = addUtcMonths(startsAt, index + 1);
    const periodEnd = fullEnd < endsAt ? fullEnd : endsAt;
    const amount =
      periodEnd.getTime() === fullEnd.getTime()
        ? monthly
        : (monthly * BigInt(periodEnd.getTime() - periodStart.getTime())) /
          BigInt(fullEnd.getTime() - periodStart.getTime());
    if (amount > 0n) schedule.push({ periodStart, periodEnd, amount: microsToMoney(amount) });
  }
  return schedule;
}

/** Current month plus two future months, retaining the original grant's calendar anchor. */
function lifetimeAllowanceSchedule(startsAt: Date, now: Date, amount: string) {
  let index = Math.max(
    0,
    (now.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 +
      now.getUTCMonth() -
      startsAt.getUTCMonth(),
  );
  if (index > 0 && addUtcMonths(startsAt, index) > now) index -= 1;
  return Array.from({ length: 3 }, (_, offset) => ({
    periodStart: addUtcMonths(startsAt, index + offset),
    periodEnd: addUtcMonths(startsAt, index + offset + 1),
    amount,
    index: index + offset,
  }));
}

/** The plan policy a grant publishes; the same catalogue values a paid projection uses. */
export function grantEntitlementPlanValues(
  grant: Pick<SubscriptionGrant, "plan_key" | "catalog_version">,
) {
  const plan = resolveSubscriptionPlanDefinition(grant.plan_key, grant.catalog_version);
  return {
    plan_key: grant.plan_key,
    catalog_version: grant.catalog_version,
    completions_rpm: plan.rateLimits.completionsRpm,
    embeddings_rpm: plan.rateLimits.embeddingsRpm,
    standard_rpm: plan.rateLimits.standardRpm,
    strict_rpm: plan.rateLimits.strictRpm,
    cloud_characters_ceiling: plan.resourceCeilings.cloudCharacters,
    agent_sandboxes_ceiling: plan.resourceCeilings.agentSandboxes,
    containers_ceiling: plan.resourceCeilings.containers,
    storage_gib_ceiling: plan.resourceCeilings.storageGiB,
    apps_ceiling: plan.resourceCeilings.apps,
  };
}

/** Subscription states that still bill (or may bill) the organization; mirrors the open-subscription index. */
const OPEN_PAID_SUBSCRIPTION_STATES = [
  "pending",
  "incomplete",
  "active",
  "grace",
  "past_due",
  "unpaid",
] as const;

/**
 * True when the organization has an open organization subscription or its
 * subscription authority is unknown. Locks the authority row in the billing
 * order the projection write uses later in the same transaction.
 */
async function organizationHasPaidPlanObligation(
  tx: DbTransaction,
  organizationId: string,
): Promise<boolean> {
  const [association] = await tx
    .select({ state: organizationSubscriptionAuthorities.state })
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, organizationId))
    .for("update");
  if (association?.state === "unavailable") return true;
  const [open] = await tx
    .select({ id: billingSubscriptions.id })
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.organization_id, organizationId),
        isNull(billingSubscriptions.billing_scope_id),
        inArray(billingSubscriptions.status, [...OPEN_PAID_SUBSCRIPTION_STATES]),
      ),
    )
    .limit(1);
  return open !== undefined;
}

/** The end of a grant redeemed at `now` under the code's single term; null is lifetime. */
export function grantEndsAt(
  code: { duration_days: number | null; duration_months: number | null },
  now: Date,
): Date | null {
  if (code.duration_months !== null) return addUtcMonths(now, code.duration_months);
  return code.duration_days === null ? null : new Date(now.getTime() + code.duration_days * DAY_MS);
}

/** The organization's unrevoked grant whose window contains `now`, latest end first. */
export async function readActiveSubscriptionGrant(
  tx: DbTransaction,
  organizationId: string,
  now: Date,
): Promise<SubscriptionGrant | undefined> {
  const [grant] = await tx
    .select()
    .from(subscriptionGrants)
    .where(
      and(
        eq(subscriptionGrants.organization_id, organizationId),
        isNull(subscriptionGrants.revoked_at),
        lte(subscriptionGrants.starts_at, now),
        or(isNull(subscriptionGrants.ends_at), gt(subscriptionGrants.ends_at, now)),
      ),
    )
    .orderBy(desc(subscriptionGrants.ends_at))
    .limit(1);
  return grant;
}

export interface SubscriptionGrantObservation {
  grant: SubscriptionGrant;
  /** The grant's allowance bucket whose window contains the read time, if any. */
  period: SubscriptionAllowancePeriod | undefined;
}

/**
 * Read-only: the active grant at `at` and its current allowance bucket, for
 * account readback (cross-device free-through date and declared allowance).
 * Serving decisions stay with the organization policy reader.
 */
export async function readSubscriptionGrantObservation(
  tx: DbTransaction,
  organizationId: string,
  at: Date,
): Promise<SubscriptionGrantObservation | null> {
  const grant = await readActiveSubscriptionGrant(tx, organizationId, at);
  if (!grant) return null;
  const [period] = await tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.organization_id, organizationId),
        eq(subscriptionAllowancePeriods.promo_grant_id, grant.id),
        lte(subscriptionAllowancePeriods.period_start, at),
        gt(subscriptionAllowancePeriods.period_end, at),
      ),
    )
    .limit(1);
  return { grant, period };
}

export class SubscriptionGrantsRepository {
  async redeem(input: RedeemSubscriptionGrantInput): Promise<RedeemSubscriptionGrantResult> {
    return writeTransaction((tx) => this.redeemInTransaction(tx, input));
  }

  async redeemInTransaction(
    tx: DbTransaction,
    input: RedeemSubscriptionGrantInput,
  ): Promise<RedeemSubscriptionGrantResult> {
    await ensureInferencePolicyMutation(tx, input.organizationId);

    // Billing lock order: organization first, then the shared code row.
    const [organization] = await tx
      .select({
        id: organizations.id,
        is_active: organizations.is_active,
        account_lifecycle_state: organizations.account_lifecycle_state,
      })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");
    if (
      !organization ||
      !organization.is_active ||
      organization.account_lifecycle_state !== "active"
    )
      grantError(
        "SUBSCRIPTION_GRANT_ORGANIZATION_UNAVAILABLE",
        "Organization cannot receive a grant",
        {
          organizationId: input.organizationId,
        },
      );

    const [code] = await tx
      .select()
      .from(subscriptionGrantCodes)
      .where(eq(subscriptionGrantCodes.code_hash, input.codeHash))
      .for("update");
    if (!code) grantError(SUBSCRIPTION_GRANT_CODE_INVALID, "Subscription code is not valid");

    const existing = await tx
      .select()
      .from(subscriptionGrants)
      .where(eq(subscriptionGrants.organization_id, input.organizationId));
    // A replay of this organization's own redemption answers first, even after
    // the code is disabled or used up.
    const sameCode = existing.find((grant) => grant.code_id === code.id);
    if (sameCode) return { grant: sameCode, replayed: true };

    // Any code that is not redeemable now gets the generic answer before the
    // family and idempotency checks, so those answers cannot confirm that a
    // disabled, expired or used-up code exists.
    const now = await readPostLockDatabaseNow(tx);
    if (
      code.disabled_at !== null ||
      (code.expires_at !== null && code.expires_at <= now) ||
      code.redeemed_count >= code.max_redemptions
    )
      grantError(SUBSCRIPTION_GRANT_CODE_INVALID, "Subscription code is not valid");
    if (existing.some((grant) => grant.idempotency_key === input.idempotencyKey))
      grantError(
        SUBSCRIPTION_GRANT_IDEMPOTENCY_CONFLICT,
        "Idempotency key was used for a different redemption",
        { organizationId: input.organizationId },
      );
    if (existing.some((grant) => grant.family === code.family))
      grantError(SUBSCRIPTION_GRANT_ALREADY_GRANTED, "Organization already holds this grant", {
        organizationId: input.organizationId,
      });
    if (
      code.requires_no_paid_plan &&
      (await organizationHasPaidPlanObligation(tx, input.organizationId))
    )
      grantError(
        SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE,
        "Organization has a paid subscription; this code cannot be added to it",
        { organizationId: input.organizationId },
      );

    const plan = resolveSubscriptionPlanDefinition(code.plan_key, code.catalog_version);
    const startsAt = now;
    const endsAt = grantEndsAt(code, now);
    const [grant] = await tx
      .insert(subscriptionGrants)
      .values({
        organization_id: input.organizationId,
        user_id: input.userId,
        code_id: code.id,
        family: code.family,
        plan_key: code.plan_key,
        catalog_version: code.catalog_version,
        idempotency_key: input.idempotencyKey,
        starts_at: startsAt,
        ends_at: endsAt,
        created_at: now,
      })
      .returning();
    if (!grant) throw new Error("Subscription grant insert returned no row");
    const [counted] = await tx
      .update(subscriptionGrantCodes)
      .set({ redeemed_count: code.redeemed_count + 1 })
      .where(
        and(
          eq(subscriptionGrantCodes.id, code.id),
          eq(subscriptionGrantCodes.redeemed_count, code.redeemed_count),
        ),
      )
      .returning({ id: subscriptionGrantCodes.id });
    if (!counted) throw new Error("Subscription code redemption count changed under lock");

    await this.grantAllowanceInTransaction(tx, grant, plan.allowance.amountUsd, now);
    const projected = await this.publishProjectionInTransaction(tx, grant, now);
    await advanceOrganizationPolicyGeneration(tx, {
      organizationId: input.organizationId,
      reason: "entitlement",
      actor: "system:subscription_grant",
      change: {
        grantId: grant.id,
        planKey: grant.plan_key,
        endsAt: grant.ends_at?.toISOString() ?? null,
        projectionRevision: projected?.projection_revision ?? null,
      },
    });
    return { grant, replayed: false };
  }

  private async grantAllowanceInTransaction(
    tx: DbTransaction,
    grant: SubscriptionGrant,
    monthlyAmountUsd: string,
    now: Date,
  ): Promise<number> {
    const environment = isProductionDeployment(getCloudAwareEnv()) ? "live" : "test";
    const schedule =
      grant.ends_at === null
        ? lifetimeAllowanceSchedule(grant.starts_at, now, monthlyAmountUsd)
        : grantAllowanceSchedule(grant.starts_at, grant.ends_at, monthlyAmountUsd);
    let created = 0;
    for (const [index, bucket] of schedule.entries()) {
      const periodIndex = "index" in bucket ? bucket.index : index;
      // The organization lock serializes replenishment, redemption and revocation.
      const [existing] = await tx
        .select({ id: subscriptionAllowancePeriods.id })
        .from(subscriptionAllowancePeriods)
        .where(
          and(
            eq(subscriptionAllowancePeriods.promo_grant_id, grant.id),
            eq(subscriptionAllowancePeriods.period_start, bucket.periodStart),
          ),
        );
      if (existing) continue;
      const [period] = await tx
        .insert(subscriptionAllowancePeriods)
        .values({
          organization_id: grant.organization_id,
          subscription_id: null,
          subscription_revision: null,
          provider: "eliza",
          provider_environment: environment,
          grant_source: "promo_grant",
          promo_grant_id: grant.id,
          plan_key: grant.plan_key,
          catalog_version: grant.catalog_version,
          period_start: bucket.periodStart,
          period_end: bucket.periodEnd,
          expires_at: bucket.periodEnd,
          granted_amount: bucket.amount,
          available_amount: bucket.amount,
        })
        .returning({ id: subscriptionAllowancePeriods.id });
      if (!period) throw new Error("Grant allowance insert returned no row");
      await tx.insert(subscriptionAllowanceTransactions).values({
        organization_id: grant.organization_id,
        allowance_period_id: period.id,
        sequence: 1,
        kind: "grant",
        amount: bucket.amount,
        available_before: "0.000000",
        available_after: bucket.amount,
        reserved_before: "0.000000",
        reserved_after: "0.000000",
        settled_before: "0.000000",
        settled_after: "0.000000",
        expired_before: "0.000000",
        expired_after: "0.000000",
        clawed_back_before: "0.000000",
        clawed_back_after: "0.000000",
        idempotency_key: `promo_grant:${grant.id}:${periodIndex}`,
        request_digest: await sha256Hex(
          [
            "promo_grant",
            grant.id,
            String(periodIndex),
            bucket.periodStart.toISOString(),
            bucket.amount,
          ].join("\0"),
        ),
        metadata: { promoGrantId: grant.id },
        occurred_at: now,
      });
      created += 1;
    }
    return created;
  }

  /** Extends only missing lifetime allowance windows; missed months never accumulate. */
  async replenishLifetimeAllowances(limit = 5): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Lifetime grant replenishment limit must be 1 to 100");
    const candidates = await dbWrite
      .select({ id: subscriptionGrants.id, organizationId: subscriptionGrants.organization_id })
      .from(subscriptionGrants)
      .innerJoin(organizations, eq(organizations.id, subscriptionGrants.organization_id))
      .where(
        and(
          eq(organizations.is_active, true),
          eq(organizations.account_lifecycle_state, "active"),
          isNull(subscriptionGrants.ends_at),
          isNull(subscriptionGrants.revoked_at),
          sql`${subscriptionGrants.starts_at} <= clock_timestamp()`,
          sql`NOT EXISTS (SELECT 1 FROM ${subscriptionAllowancePeriods} p WHERE p.promo_grant_id = ${subscriptionGrants.id}
          AND p.period_end > clock_timestamp() + interval '35 days')`,
        ),
      )
      .orderBy(subscriptionGrants.id)
      .limit(limit);
    let created = 0;
    for (const candidate of candidates) {
      created += await writeTransaction(async (tx) => {
        await ensureInferencePolicyMutation(tx, candidate.organizationId);
        const [org] = await tx
          .select({ active: organizations.is_active, state: organizations.account_lifecycle_state })
          .from(organizations)
          .where(eq(organizations.id, candidate.organizationId))
          .for("update");
        if (!org?.active || org.state !== "active") return 0;
        const [grant] = await tx
          .select()
          .from(subscriptionGrants)
          .where(eq(subscriptionGrants.id, candidate.id))
          .for("update");
        const now = await readPostLockDatabaseNow(tx);
        if (!grant || grant.ends_at !== null || grant.revoked_at !== null || grant.starts_at > now)
          return 0;
        const plan = resolveSubscriptionPlanDefinition(grant.plan_key, grant.catalog_version);
        const count = await this.grantAllowanceInTransaction(
          tx,
          grant,
          plan.allowance.amountUsd,
          now,
        );
        if (count)
          await advanceOrganizationPolicyGeneration(tx, {
            organizationId: candidate.organizationId,
            reason: "entitlement",
            actor: "system:subscription_grant",
            change: { grantId: grant.id, replenishedPeriods: count },
          });
        return count;
      });
    }
    return created;
  }

  /**
   * An organization without a Stripe subscription has no paid projection to
   * preserve: the grant becomes its projection for the grant window. An
   * organization with subscription authority keeps its paid projection; the
   * policy reader composes the grant once that subscription stops being effective.
   */
  private async publishProjectionInTransaction(
    tx: DbTransaction,
    grant: SubscriptionGrant,
    now: Date,
  ): Promise<OrganizationEntitlement | undefined> {
    const [association] = await tx
      .select({ state: organizationSubscriptionAuthorities.state })
      .from(organizationSubscriptionAuthorities)
      .where(eq(organizationSubscriptionAuthorities.organization_id, grant.organization_id))
      .for("update");
    if (association?.state !== "none") return undefined;
    const [current] = await tx
      .select()
      .from(organizationEntitlements)
      .where(
        and(
          eq(organizationEntitlements.organization_id, grant.organization_id),
          isNull(organizationEntitlements.billing_scope_id),
        ),
      )
      .for("update");
    // A longer-running grant projection from another family keeps its window.
    if (
      current?.source_grant_id &&
      (current.effective_until === null ||
        (grant.ends_at !== null && current.effective_until >= grant.ends_at))
    )
      return current;
    return this.writeProjectionInTransaction(tx, grant.organization_id, current, {
      ...grantEntitlementPlanValues(grant),
      state: "active" as const,
      access: "granted" as const,
      entitlement_effective: true,
      effective_from: grant.starts_at,
      effective_until: grant.ends_at,
      source_subscription_id: null,
      source_subscription_revision: null,
      source_grant_id: grant.id,
      source_digest: await sha256Hex(`promo_grant\0${grant.id}`),
      rebuilt_at: now,
      updated_at: now,
    });
  }

  private async writeProjectionInTransaction(
    tx: DbTransaction,
    organizationId: string,
    current: OrganizationEntitlement | undefined,
    values: Omit<
      typeof organizationEntitlements.$inferInsert,
      "organization_id" | "projection_revision"
    >,
  ): Promise<OrganizationEntitlement | undefined> {
    if (!current) {
      const [inserted] = await tx
        .insert(organizationEntitlements)
        .values({ ...values, organization_id: organizationId, projection_revision: 0 })
        .returning();
      return inserted;
    }
    const [updated] = await tx
      .update(organizationEntitlements)
      .set({ ...values, projection_revision: current.projection_revision + 1 })
      .where(
        and(
          eq(organizationEntitlements.id, current.id),
          eq(organizationEntitlements.projection_revision, current.projection_revision),
        ),
      )
      .returning();
    if (!updated) throw new Error("Grant entitlement projection changed under lock");
    return updated;
  }

  async revoke(input: RevokeSubscriptionGrantInput): Promise<RevokeSubscriptionGrantResult> {
    return writeTransaction((tx) => this.revokeInTransaction(tx, input));
  }

  /**
   * Ends a grant at once (support revocation). In one transaction: marks the
   * grant revoked, retires its open allowance buckets, moves a projection that
   * names the grant to the organization's next active grant or back to free,
   * and advances the policy generation. A revoked grant keeps the
   * organization's slot in its code family. Revoking twice is a no-op.
   */
  async revokeInTransaction(
    tx: DbTransaction,
    input: RevokeSubscriptionGrantInput,
  ): Promise<RevokeSubscriptionGrantResult> {
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 500)
      throw new Error("Revocation reason must be 1 to 500 characters");
    const [target] = await tx
      .select({ organization_id: subscriptionGrants.organization_id })
      .from(subscriptionGrants)
      .where(eq(subscriptionGrants.id, input.grantId));
    if (!target)
      grantError(SUBSCRIPTION_GRANT_NOT_FOUND, "Subscription grant does not exist", {
        grantId: input.grantId,
      });
    const organizationId = target.organization_id;
    await ensureInferencePolicyMutation(tx, organizationId);

    // Billing lock order: organization first, then its grant rows.
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update");
    const [grant] = await tx
      .select()
      .from(subscriptionGrants)
      .where(eq(subscriptionGrants.id, input.grantId))
      .for("update");
    if (!grant) throw new Error("Subscription grant disappeared under lock");
    if (grant.revoked_at !== null) return { grant, revoked: false, retiredPeriods: 0 };

    const now = await readPostLockDatabaseNow(tx);
    const [revoked] = await tx
      .update(subscriptionGrants)
      .set({ revoked_at: now, revoked_reason: reason })
      .where(and(eq(subscriptionGrants.id, grant.id), isNull(subscriptionGrants.revoked_at)))
      .returning();
    if (!revoked) throw new Error("Subscription grant revocation lost under lock");

    const open = await tx
      .select({ id: subscriptionAllowancePeriods.id })
      .from(subscriptionAllowancePeriods)
      .where(
        and(
          eq(subscriptionAllowancePeriods.organization_id, organizationId),
          eq(subscriptionAllowancePeriods.promo_grant_id, grant.id),
          eq(subscriptionAllowancePeriods.state, "open"),
        ),
      );
    let retiredPeriods = 0;
    for (const period of open) {
      const result = await subscriptionAllowanceRepository.retirePeriodInTransaction(tx, {
        organizationId,
        periodId: period.id,
        reason: "grant_revoked",
      });
      if (result.retired) retiredPeriods += 1;
    }

    const [association] = await tx
      .select({ state: organizationSubscriptionAuthorities.state })
      .from(organizationSubscriptionAuthorities)
      .where(eq(organizationSubscriptionAuthorities.organization_id, organizationId))
      .for("update");
    let projectionRevision: number | null = null;
    if (association?.state === "none") {
      const [current] = await tx
        .select()
        .from(organizationEntitlements)
        .where(
          and(
            eq(organizationEntitlements.organization_id, organizationId),
            isNull(organizationEntitlements.billing_scope_id),
          ),
        )
        .for("update");
      if (current?.source_grant_id === grant.id) {
        const next = await readActiveSubscriptionGrant(tx, organizationId, now);
        const projected = await this.writeProjectionInTransaction(
          tx,
          organizationId,
          current,
          next
            ? {
                ...grantEntitlementPlanValues(next),
                state: "active",
                access: "granted",
                entitlement_effective: true,
                effective_from: next.starts_at,
                effective_until: next.ends_at,
                source_subscription_id: null,
                source_subscription_revision: null,
                source_grant_id: next.id,
                source_digest: await sha256Hex(`promo_grant\0${next.id}`),
                rebuilt_at: now,
                updated_at: now,
              }
            : {
                ...SUBSCRIPTION_FREE_ENTITLEMENT_VALUES,
                access: "granted",
                effective_from: now,
                source_digest: await sha256Hex(`promo_grant_revoked\0${grant.id}`),
                rebuilt_at: now,
                updated_at: now,
              },
        );
        projectionRevision = projected?.projection_revision ?? null;
      }
    }
    await advanceOrganizationPolicyGeneration(tx, {
      organizationId,
      reason: "entitlement",
      actor: "system:subscription_grant_revocation",
      change: { grantId: grant.id, revokedAt: now.toISOString(), projectionRevision },
    });
    return { grant: revoked, revoked: true, retiredPeriods };
  }
}

export interface RevokeSubscriptionGrantInput {
  grantId: string;
  reason: string;
}

export interface RevokeSubscriptionGrantResult {
  grant: SubscriptionGrant;
  /** False when the grant was already revoked. */
  revoked: boolean;
  retiredPeriods: number;
}

export const subscriptionGrantsRepository = new SubscriptionGrantsRepository();
