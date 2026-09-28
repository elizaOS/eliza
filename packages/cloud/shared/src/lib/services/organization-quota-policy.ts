/** Resolves organization policy from one primary transaction for observation, inference and resource admission. */
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { type DbTransaction, dbWrite } from "../../db/client";
import { readPrimaryOrganizationSubscription } from "../../db/repositories/account-billing-snapshot-subscription";
import {
  deriveSubscriptionEntitlementValues,
  SUBSCRIPTION_FREE_ENTITLEMENT_VALUES,
} from "../../db/repositories/subscription-entitlements";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../../db/schemas/billing-subscriptions";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { orgRateLimitOverrides } from "../../db/schemas/org-rate-limit-overrides";
import { orgStorageQuota } from "../../db/schemas/org-storage-quota";
import { organizationConfig } from "../../db/schemas/organization-config";
import { organizations } from "../../db/schemas/organizations";
import { getMaxNonTerminalAgentsForOrg } from "../constants/agent-sandbox-quota";
import { getMaxAppsPerOrg } from "../constants/app-quota";
import { resolveMaxCloudCharactersForOrg } from "../constants/cloud-character-quota";
import { resolveMaxContainersForOrg } from "../constants/pricing";
import {
  ORG_TIER_PURCHASED_CREDIT_SOURCES,
  type OrgTierData,
  resolveOrgTierFromSourceValues,
} from "./org-rate-limits";
import {
  API_KEY_CEILINGS,
  resolveSubscriptionPlanDefinition,
  SubscriptionCatalogError,
} from "./subscription-catalog";
import { withSubscriptionPaymentGrace } from "./subscription-payment-grace";

export interface OrganizationPolicyStamp {
  generation: string;
  source: "legacy" | "subscription";
  sourceSubscriptionId: string | null;
  sourceRevision: string | null;
  projectionRevision: string | null;
  catalogVersion: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
}
export type OrganizationResource =
  | "characters"
  | "nonEagerSandboxes"
  | "sandboxes"
  | "containers"
  | "apps"
  | "storage"
  | "apiKeys";
export type OrganizationResourceLimit =
  | { status: "available"; limit: bigint; source: string }
  | { status: "unavailable"; code: string };
export type PolicyObservation<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; code: string };
function observe<T>(read: () => T): PolicyObservation<T> {
  try {
    return { status: "available", value: read() };
  } catch (error) {
    // error-policy:J4 only typed persisted selector failures become unavailable observations.
    if (
      !(error instanceof ElizaError) ||
      ![
        "ORG_RATE_LIMIT_SOURCE_INVALID",
        "INVALID_CLOUD_CHARACTER_QUOTA_SOURCE",
        "INVALID_AGENT_SANDBOX_QUOTA_SOURCE",
        "MISSING_CONTAINER_QUOTA_SOURCE",
        "INVALID_CONTAINER_QUOTA_SOURCE",
        "INVALID_MAX_APPS_PER_ORG",
        "ORGANIZATION_POLICY_UNAVAILABLE",
      ].includes(error.code)
    )
      throw error;
    return { status: "unavailable", code: error.code };
  }
}
function resource(read: () => OrganizationResourceLimit): OrganizationResourceLimit {
  const result = observe(read);
  return result.status === "available" ? result.value : result;
}
export function requireOrganizationRateTier(policy: OrganizationQuotaPolicy): OrgTierData {
  if (policy.tier.status !== "available") return unavailable("", policy.tier.code);
  return policy.tier.value;
}
export function requireOrganizationPolicyBalance(policy: OrganizationQuotaPolicy): {
  balanceUsd: number;
  revision: string;
} {
  if (policy.balance.status !== "available") return unavailable("", policy.balance.code);
  return policy.balance.value;
}
export interface OrganizationQuotaPolicy {
  authority: OrganizationPolicyStamp;
  tier: PolicyObservation<OrgTierData>;
  subscriptionFunded: boolean;
  tierSourceCreditTotal: string | null;
  overrides: {
    completionsRpm: number | null;
    embeddingsRpm: number | null;
    standardRpm: number | null;
    strictRpm: number | null;
  };
  limits: Record<OrganizationResource, OrganizationResourceLimit>;
  observedAt: string;
  balance: PolicyObservation<{ balanceUsd: number; revision: string }>;
}
function unavailable(organizationId: string, reason: string): never {
  throw new ElizaError("Organization policy is unavailable", {
    code: "ORGANIZATION_POLICY_UNAVAILABLE",
    context: { organizationId, reason },
    severity: "ephemeral",
  });
}
function limit(value: number | bigint | null, source: string): OrganizationResourceLimit {
  if (value === null) return { status: "unavailable", code: "resource_policy_unavailable" };
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new ElizaError("Organization ceiling is invalid", {
      code: "ORGANIZATION_POLICY_UNAVAILABLE",
      context: { source },
    });
  return { status: "available", limit: BigInt(value), source };
}
/** API-key count ceiling for the granted plan, read from the immutable catalogue. */
function subscriptionApiKeyLimit(
  planKey: string,
  catalogVersion: string | null,
): OrganizationResourceLimit {
  if (planKey !== "plus_monthly" && planKey !== "pro_monthly")
    return limit(API_KEY_CEILINGS.free, "subscription-catalog");
  try {
    return limit(
      resolveSubscriptionPlanDefinition(planKey, catalogVersion ?? "").resourceCeilings.apiKeys,
      "subscription-catalog",
    );
  } catch (error) {
    // error-policy:J4 an unknown catalogue revision is an unavailable ceiling,
    // which admission refuses with RESOURCE_POLICY_UNAVAILABLE.
    if (error instanceof SubscriptionCatalogError)
      return { status: "unavailable", code: "resource_policy_unavailable" };
    throw error;
  }
}
export function requireOrganizationResourceLimit(
  policy: OrganizationQuotaPolicy,
  resource: OrganizationResource,
): bigint {
  const observation = policy.limits[resource];
  if (observation.status !== "available")
    throw new ElizaError("Resource ceiling has not been approved", {
      code: "RESOURCE_POLICY_UNAVAILABLE",
      context: { resource, catalogVersion: policy.authority.catalogVersion },
      severity: "ephemeral",
    });
  return observation.limit;
}
const paymentIdentity = sql`COALESCE(${creditTransactions.stripe_payment_intent_id}, '')`;
const purchasedPaymentIdentity = sql.join(
  ORG_TIER_PURCHASED_CREDIT_SOURCES.paymentIdentityPrefixes.map(
    (prefix) => sql`starts_with(${paymentIdentity}, ${prefix})`,
  ),
  sql` OR `,
);
const purchasedMetadataType = sql.join(
  ORG_TIER_PURCHASED_CREDIT_SOURCES.metadataTypes.map((value) => sql`${value}`),
  sql`,`,
);
const decimalPattern = "^[0-9]+(\\.[0-9]+)?$";
const metadataDecimal = (field: string) =>
  sql`CASE WHEN ${creditTransactions.metadata}->>${field} ~ ${decimalPattern}
    THEN (${creditTransactions.metadata}->>${field})::numeric END`;
/**
 * One ledger row's contribution to the pay-as-you-go RPM tier: purchased
 * credits add, reversal clawbacks subtract their requested amount, and a
 * won-dispute reinstatement adds back. Every other provenance contributes 0.
 */
const purchasedCreditTierAmount = sql`CASE
  WHEN ${creditTransactions.type} = 'credit' AND (${purchasedPaymentIdentity}
    OR COALESCE(${creditTransactions.metadata}->>'type', '') IN (${purchasedMetadataType}))
    THEN ${creditTransactions.amount}
  WHEN ${creditTransactions.type} = 'credit'
    AND starts_with(${paymentIdentity}, ${ORG_TIER_PURCHASED_CREDIT_SOURCES.bonusExcludedPaymentIdentityPrefix})
    THEN LEAST(${creditTransactions.amount}, COALESCE(
      ${metadataDecimal("paid_amount_usd")},
      ${creditTransactions.amount} - COALESCE(${metadataDecimal("bonus_credits")}, 0)
    ))
  WHEN ${creditTransactions.type} = 'clawback'
    THEN -COALESCE(${metadataDecimal("requested_clawback_usd")}, -${creditTransactions.amount})
  WHEN ${creditTransactions.type} = 'refund'
    AND ${creditTransactions.metadata}->>'source' = 'charge.dispute.funds_reinstated'
    THEN ${creditTransactions.amount}
  ELSE 0
END`;

export async function readOrganizationQuotaPolicyInTransaction(
  tx: DbTransaction,
  organizationId: string,
  observedAt?: Date,
): Promise<OrganizationQuotaPolicy> {
  // These rows are unique per organization. One statement keeps the policy
  // inputs together without paying a separate database round trip for each.
  const [inputs] = await tx
    .select({
      // Legacy policy has no expiry boundary to recheck after further reads.
      // Observe its database clock with the policy inputs, not another round trip.
      legacyObservedAt: sql<Date>`clock_timestamp()`,
      org: {
        balance: organizations.credit_balance,
        revision: sql<string>`${organizations.balance_revision}::text`,
        settings: organizations.settings,
      },
      association: organizationSubscriptionAuthorities,
      override: {
        // The row can exist with null RPM fields; retain its non-null join identity.
        id: orgRateLimitOverrides.id,
        completions_rpm: orgRateLimitOverrides.completions_rpm,
        embeddings_rpm: orgRateLimitOverrides.embeddings_rpm,
        standard_rpm: orgRateLimitOverrides.standard_rpm,
        strict_rpm: orgRateLimitOverrides.strict_rpm,
      },
      config: { settings: organizationConfig.settings },
      storage: {
        bytes_limit: orgStorageQuota.bytes_limit,
        limit_override_authorized: orgStorageQuota.limit_override_authorized,
      },
      // Correlated selectors preserve one policy row per organization. The
      // legacy branch still rejects any persisted subscription, including a
      // terminal one, and sums only net purchased credits (#23019).
      legacyHasSubscription: sql<
        boolean | null
      >`CASE WHEN ${organizationSubscriptionAuthorities.state} = 'none' THEN EXISTS (
        SELECT 1 FROM ${billingSubscriptions}
        WHERE ${billingSubscriptions.organization_id} = ${organizations.id}
      ) END`,
      legacyCreditTotal: sql<
        string | null
      >`CASE WHEN ${organizationSubscriptionAuthorities.state} = 'none' THEN (
        SELECT GREATEST(COALESCE(SUM(${purchasedCreditTierAmount}), 0), 0)::text
        FROM ${creditTransactions}
        WHERE ${creditTransactions.organization_id} = ${organizations.id}
      ) END`,
    })
    .from(organizations)
    .leftJoin(
      organizationSubscriptionAuthorities,
      eq(organizationSubscriptionAuthorities.organization_id, organizations.id),
    )
    .leftJoin(orgRateLimitOverrides, eq(orgRateLimitOverrides.organization_id, organizations.id))
    .leftJoin(organizationConfig, eq(organizationConfig.organization_id, organizations.id))
    .leftJoin(orgStorageQuota, eq(orgStorageQuota.organization_id, organizations.id))
    .where(eq(organizations.id, organizationId));
  if (!inputs || !inputs.association || inputs.association.state === "unavailable")
    return unavailable(organizationId, "missing_account_authority");
  const { org, association, override, config, storage } = inputs;
  const balance = Number(org.balance);
  const validBalance =
    typeof org.balance === "string" &&
    /^[+-]?(?:\d+|\d*\.\d+)$/.test(org.balance.trim()) &&
    Number.isFinite(balance);
  const base = {
    overrides: {
      completionsRpm: override?.completions_rpm ?? null,
      embeddingsRpm: override?.embeddings_rpm ?? null,
      standardRpm: override?.standard_rpm ?? null,
      strictRpm: override?.strict_rpm ?? null,
    },
    balance: validBalance
      ? { status: "available" as const, value: { balanceUsd: balance, revision: org.revision } }
      : { status: "unavailable" as const, code: "invalid_balance" },
  };
  if (association.state === "none") {
    if (inputs.legacyHasSubscription !== false)
      return unavailable(organizationId, "legacy_association_conflict");
    if (inputs.legacyCreditTotal === null)
      return unavailable(organizationId, "missing_legacy_selector");
    const creditTotal = inputs.legacyCreditTotal;
    const now = observedAt ?? new Date(inputs.legacyObservedAt);
    return {
      ...base,
      observedAt: now.toISOString(),
      authority: {
        generation: association.policy_generation.toString(),
        source: "legacy",
        sourceSubscriptionId: null,
        sourceRevision: null,
        projectionRevision: null,
        catalogVersion: null,
        effectiveFrom: new Date(0).toISOString(),
        effectiveUntil: null,
      },
      tier: observe(
        () =>
          resolveOrgTierFromSourceValues(organizationId, creditTotal, override ?? undefined)
            .tierData,
      ),
      tierSourceCreditTotal: creditTotal,
      subscriptionFunded: false,
      limits: {
        characters: resource(() =>
          limit(
            resolveMaxCloudCharactersForOrg(validBalance ? balance : Number.NaN, org.settings)
              .limit,
            resolveMaxCloudCharactersForOrg(validBalance ? balance : Number.NaN, org.settings)
              .source,
          ),
        ),
        nonEagerSandboxes: limit(getMaxNonTerminalAgentsForOrg(undefined), "default_free_tier"),
        sandboxes: resource(() =>
          limit(
            getMaxNonTerminalAgentsForOrg(validBalance ? balance : Number.NaN),
            "legacy-sandbox-policy",
          ),
        ),
        containers: resource(() =>
          limit(
            resolveMaxContainersForOrg(validBalance ? balance : Number.NaN, config?.settings).limit,
            "legacy-container-policy",
          ),
        ),
        apps: resource(() => limit(getMaxAppsPerOrg(), "legacy-app-policy")),
        storage: limit(storage?.bytes_limit ?? 5n * 1024n * 1024n * 1024n, "legacy-storage-policy"),
        apiKeys: limit(API_KEY_CEILINGS.free, "pay-as-you-go-policy"),
      },
    };
  }
  const current = await readPrimaryOrganizationSubscription(tx, organizationId);
  if (current.state !== "current")
    return unavailable(organizationId, "subscription_source_mismatch");
  const entitlement = current.entitlement;
  const [revision] = await tx
    .select()
    .from(billingSubscriptionRevisions)
    .where(
      and(
        eq(billingSubscriptionRevisions.subscription_id, current.subscription.id),
        eq(billingSubscriptionRevisions.organization_id, organizationId),
        eq(billingSubscriptionRevisions.revision, current.subscription.lifecycle_revision),
      ),
    );
  if (!revision) return unavailable(organizationId, "subscription_revision_unavailable");
  const expected = deriveSubscriptionEntitlementValues(revision);
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    const actualValue = entitlement[key];
    const expectedValue = expected[key];
    if (
      actualValue instanceof Date && expectedValue instanceof Date
        ? actualValue.getTime() !== expectedValue.getTime()
        : actualValue !== expectedValue
    )
      return unavailable(organizationId, "subscription_projection_conflict");
  }
  const [clock] = await tx
    .select({ now: sql<Date>`clock_timestamp()` })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!clock) return unavailable(organizationId, "missing_database_clock");
  const now = observedAt ?? new Date(clock.now);
  if (now < entitlement.effective_from)
    return unavailable(organizationId, "entitlement_not_effective");
  // Stripe settles renewals shortly after the stored period end, so an active
  // paid projection keeps access through the shared payment grace. Past that
  // boundary, or in a non-effective dunning state, the organization is served
  // as the free tier rather than failing every policy read.
  const paidUntil =
    entitlement.effective_until !== null && entitlement.state === "active"
      ? withSubscriptionPaymentGrace(entitlement.effective_until)
      : entitlement.effective_until;
  const lapsed = !entitlement.entitlement_effective || (paidUntil !== null && now >= paidUntil);
  const granted = lapsed
    ? { ...entitlement, ...SUBSCRIPTION_FREE_ENTITLEMENT_VALUES }
    : entitlement;
  const grantedFrom =
    lapsed && entitlement.entitlement_effective && paidUntil !== null
      ? paidUntil
      : entitlement.effective_from;
  const grantedUntil = lapsed ? null : paidUntil;
  const characterOverride = observe(() => resolveMaxCloudCharactersForOrg(0, org.settings));
  const containerOverride = observe(() => resolveMaxContainersForOrg(0, config?.settings));
  const tier: OrgTierData = {
    tierName: granted.plan_key,
    completionsRpm: override?.completions_rpm ?? granted.completions_rpm,
    embeddingsRpm: override?.embeddings_rpm ?? granted.embeddings_rpm,
    standardRpm: override?.standard_rpm ?? granted.standard_rpm,
    strictRpm: override?.strict_rpm ?? granted.strict_rpm,
  };
  if (
    override &&
    [
      override.completions_rpm,
      override.embeddings_rpm,
      override.standard_rpm,
      override.strict_rpm,
    ].some((value) => value !== null)
  )
    tier.tierName = "custom";
  const [stored] = await tx
    .select({ generation: organizationSubscriptionAuthorities.policy_generation })
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, organizationId));
  if (!stored) return unavailable(organizationId, "missing_policy_generation");
  return {
    ...base,
    observedAt: now.toISOString(),
    authority: {
      generation: stored.generation.toString(),
      source: "subscription",
      sourceSubscriptionId: current.subscription.id,
      sourceRevision: String(current.subscription.lifecycle_revision),
      projectionRevision: String(entitlement.projection_revision),
      catalogVersion: entitlement.catalog_version,
      effectiveFrom: grantedFrom.toISOString(),
      effectiveUntil: grantedUntil?.toISOString() ?? null,
    },
    tier: observe(() => {
      if (
        ![tier.completionsRpm, tier.embeddingsRpm, tier.standardRpm, tier.strictRpm].every(
          (value) => Number.isSafeInteger(value) && value > 0,
        )
      )
        return unavailable(organizationId, "invalid_rate_override");
      return tier;
    }),
    tierSourceCreditTotal: null,
    subscriptionFunded: granted.plan_key !== "free",
    limits: {
      characters:
        characterOverride.status === "unavailable"
          ? characterOverride
          : limit(
              characterOverride.value.source === "organization.settings.max_agents"
                ? characterOverride.value.limit
                : granted.cloud_characters_ceiling,
              characterOverride.value.source === "organization.settings.max_agents"
                ? characterOverride.value.source
                : "subscription-entitlement",
            ),
      nonEagerSandboxes: limit(granted.agent_sandboxes_ceiling, "subscription-entitlement"),
      sandboxes: limit(granted.agent_sandboxes_ceiling, "subscription-entitlement"),
      containers:
        containerOverride.status === "unavailable"
          ? containerOverride
          : limit(
              containerOverride.value.source === "organization_config.settings.max_containers"
                ? containerOverride.value.limit
                : granted.containers_ceiling,
              containerOverride.value.source === "organization_config.settings.max_containers"
                ? containerOverride.value.source
                : "subscription-entitlement",
            ),
      apps: limit(granted.apps_ceiling, "subscription-entitlement"),
      storage: limit(
        storage?.limit_override_authorized
          ? storage.bytes_limit
          : granted.storage_gib_ceiling === null
            ? null
            : BigInt(granted.storage_gib_ceiling) * 1024n * 1024n * 1024n,
        storage?.limit_override_authorized
          ? "authorized-storage-override"
          : "subscription-entitlement",
      ),
      apiKeys: subscriptionApiKeyLimit(granted.plan_key, granted.catalog_version),
    },
  };
}
export async function readOrganizationQuotaPolicy(
  organizationId: string,
): Promise<OrganizationQuotaPolicy> {
  return dbWrite.transaction((tx) => readOrganizationQuotaPolicyInTransaction(tx, organizationId), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
