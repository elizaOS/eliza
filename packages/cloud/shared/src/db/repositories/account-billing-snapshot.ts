/**
 * Coherent primary-database read model for the account billing snapshot.
 *
 * All PostgreSQL-backed fields are read from one primary REPEATABLE READ,
 * READ ONLY transaction. No legacy billing shadow is imported or queried;
 * `organizations` is the sole billing authority.
 */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type ActiveBillableResource,
  activeBillingService,
} from "../../lib/services/active-billing";
import {
  ORG_TIER_EXCLUDED_CREDIT_METADATA_TYPES,
  type OrgTierData,
  resolveOrgTierFromSourceValues,
} from "../../lib/services/org-rate-limits";
import { dbRead } from "../client";
import { sqlRows } from "../execute-helpers";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { apiKeys } from "../schemas/api-keys";
import { apps } from "../schemas/apps";
import {
  autoTopUpAttempts,
  autoTopUpControl,
  autoTopUpLegacyPaymentQuarantine,
} from "../schemas/auto-top-up-attempts";
import { computeBillingRateSegments } from "../schemas/compute-billing-rate-segments";
import { containers } from "../schemas/containers";
import { creditTransactions } from "../schemas/credit-transactions";
import { orgRateLimitOverrides } from "../schemas/org-rate-limit-overrides";
import { orgStorageQuota } from "../schemas/org-storage-quota";
import { organizationConfig } from "../schemas/organization-config";
import { organizations } from "../schemas/organizations";
import { userCharacters } from "../schemas/user-characters";
import { requireAccountBillingAggregateRow } from "./account-billing-snapshot-aggregates";
import { requireCustomerBindingAuthoritativeRow } from "./account-billing-snapshot-primary-values";

export interface PrimaryStatusCounts {
  used: string;
  reserved: string;
  deleting: string;
}

export interface PrimaryComputeRateSegment {
  workloadKind: "agent" | "container";
  workloadId: string;
  billingState: string;
  ratePerHour: string;
  effectiveAt: Date | string;
}

export interface PrimaryAccountBillingReadModel {
  observedAt: string;
  organization: {
    creditBalance: string;
    balanceRevision: string;
    balanceDecreaseRevision: string;
    coveredBalanceDecreaseRevision: string | null;
    settings: unknown;
    isActive: boolean;
    stripeCustomerIdPresent: boolean;
    stripeCustomerIdValid: boolean;
    defaultPaymentMethodIdPresent: boolean;
    defaultPaymentMethodIdValid: boolean;
    autoTopUpEnabled: boolean;
    autoTopUpThreshold: string | null;
    autoTopUpAmount: string | null;
  };
  cloudCharacterCount: string;
  sandboxCounts: PrimaryStatusCounts;
  containerCounts: PrimaryStatusCounts;
  containerSettings: unknown;
  appCount: string;
  apiKeyCount: string;
  storageQuota: { bytesUsed: string; bytesLimit: string } | null;
  configuredTier:
    | {
        status: "available";
        tier: OrgTierData;
        tierSourceCreditTotal: string;
        overrides: {
          completionsRpm: number | null;
          embeddingsRpm: number | null;
          standardRpm: number | null;
          strictRpm: number | null;
        };
      }
    | { status: "unavailable"; code: "configured_tier_invalid" };
  autoTopUp: {
    control: {
      mode: "paused" | "durable";
      pausedAt: Date;
      legacyReconciledThrough: Date | null;
    } | null;
    customerBindingAuthoritative: boolean;
    blockingAttempt: boolean;
    blockingLegacyQuarantine: boolean;
  };
  activeResources: ActiveBillableResource[];
  latestRateSegments: PrimaryComputeRateSegment[];
}

function exactInteger(value: unknown, field: string): string {
  const normalized = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^\d+$/.test(normalized)) {
    throw new ElizaError(`Account billing ${field} is not an exact non-negative integer`, {
      code: "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
      context: { field },
      severity: "fatal",
    });
  }
  return normalized.replace(/^0+(?=\d)/, "");
}

function exactDecimal(value: unknown, field: string): string {
  const normalized = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new ElizaError(`Account billing ${field} is not an exact non-negative decimal`, {
      code: "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
      context: { field },
      severity: "fatal",
    });
  }
  return normalized;
}

function iso(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ElizaError(`Account billing ${field} timestamp is invalid`, {
      code: "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE",
      context: { field },
      severity: "fatal",
    });
  }
  return parsed.toISOString();
}

/**
 * Read one organization only. Callers must pass the organization id resolved
 * by authentication; this function has no user-controlled organization seam.
 */
export async function readPrimaryAccountBillingSnapshot(
  organizationId: string,
): Promise<PrimaryAccountBillingReadModel> {
  return dbRead.transaction(
    async (tx) => {
      const [clock] = await sqlRows<{ observed_at: Date | string }>(
        tx,
        sql`SELECT transaction_timestamp() AS observed_at`,
      );
      if (!clock) {
        throw new ElizaError("Account billing primary clock is unavailable", {
          code: "ACCOUNT_BILLING_PRIMARY_SOURCE_UNAVAILABLE",
          severity: "fatal",
        });
      }
      const observedAt = iso(clock.observed_at, "observed_at");

      const [organization] = await tx
        .select({
          creditBalance: organizations.credit_balance,
          balanceRevision: sql<string>`${organizations.balance_revision}::text`,
          balanceDecreaseRevision: sql<string>`${organizations.balance_decrease_revision}::text`,
          coveredBalanceDecreaseRevision: sql<
            string | null
          >`${organizations.auto_top_up_covered_balance_decrease_revision}::text`,
          settings: organizations.settings,
          isActive: organizations.is_active,
          stripeCustomerId: organizations.stripe_customer_id,
          defaultPaymentMethod: organizations.stripe_default_payment_method,
          autoTopUpEnabled: organizations.auto_top_up_enabled,
          autoTopUpThreshold: organizations.auto_top_up_threshold,
          autoTopUpAmount: organizations.auto_top_up_amount,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (!organization) {
        throw new ElizaError("Authenticated organization billing authority was not found", {
          code: "ACCOUNT_BILLING_ORGANIZATION_NOT_FOUND",
          context: { organizationId },
          severity: "fatal",
        });
      }

      const [
        cloudCharacterRows,
        sandboxRows,
        containerRows,
        containerConfig,
        appRows,
        apiKeyRows,
        storageRows,
        tierSourceCreditRows,
        tierOverride,
        controlRows,
        blockingAttemptRows,
        blockingLegacyRows,
      ] = await Promise.all([
        tx
          .select({ count: sql<string>`COALESCE(count(*), 0)::text` })
          .from(userCharacters)
          .where(
            and(
              eq(userCharacters.organization_id, organizationId),
              eq(userCharacters.source, "cloud"),
            ),
          ),
        tx
          .select({
            used: sql<string>`COALESCE(count(*) FILTER (WHERE ${agentSandboxes.status} IN ('running','stopped','sleeping')), 0)::text`,
            reserved: sql<string>`COALESCE(count(*) FILTER (WHERE ${agentSandboxes.status} IN ('pending','provisioning')), 0)::text`,
            deleting: sql<string>`COALESCE(count(*) FILTER (WHERE ${agentSandboxes.status} IN ('deletion_pending','deletion_failed')), 0)::text`,
          })
          .from(agentSandboxes)
          .where(
            and(
              eq(agentSandboxes.organization_id, organizationId),
              isNull(agentSandboxes.pool_status),
            ),
          ),
        tx
          .select({
            used: sql<string>`COALESCE(count(*) FILTER (WHERE ${containers.status} NOT IN ('pending','building','deploying','deleting','deleted')), 0)::text`,
            reserved: sql<string>`COALESCE(count(*) FILTER (WHERE ${containers.status} IN ('pending','building','deploying')), 0)::text`,
            deleting: sql<string>`COALESCE(count(*) FILTER (WHERE ${containers.status} = 'deleting'), 0)::text`,
          })
          .from(containers)
          .where(eq(containers.organization_id, organizationId)),
        tx.query.organizationConfig.findFirst({
          where: eq(organizationConfig.organization_id, organizationId),
          columns: { settings: true },
        }),
        tx
          .select({ count: sql<string>`COALESCE(count(*), 0)::text` })
          .from(apps)
          .where(eq(apps.organization_id, organizationId)),
        tx
          .select({ count: sql<string>`COALESCE(count(*), 0)::text` })
          .from(apiKeys)
          .where(eq(apiKeys.organization_id, organizationId)),
        tx
          .select({
            bytesUsed: sql<string>`${orgStorageQuota.bytes_used}::text`,
            bytesLimit: sql<string>`${orgStorageQuota.bytes_limit}::text`,
          })
          .from(orgStorageQuota)
          .where(eq(orgStorageQuota.organization_id, organizationId))
          .limit(1),
        tx
          .select({
            tierSourceCreditTotal: sql<string>`COALESCE(SUM(${creditTransactions.amount}), '0')::text`,
          })
          .from(creditTransactions)
          .where(
            and(
              eq(creditTransactions.organization_id, organizationId),
              eq(creditTransactions.type, "credit"),
              sql`COALESCE(${creditTransactions.metadata}->>'type', '') NOT IN (${sql.join(
                ORG_TIER_EXCLUDED_CREDIT_METADATA_TYPES.map((type) => sql`${type}`),
                sql`, `,
              )})`,
            ),
          ),
        tx.query.orgRateLimitOverrides.findFirst({
          where: eq(orgRateLimitOverrides.organization_id, organizationId),
          columns: {
            completions_rpm: true,
            embeddings_rpm: true,
            standard_rpm: true,
            strict_rpm: true,
          },
        }),
        tx
          .select({
            mode: autoTopUpControl.mode,
            pausedAt: autoTopUpControl.paused_at,
            legacyReconciledThrough: autoTopUpControl.legacy_reconciled_through,
          })
          .from(autoTopUpControl)
          .where(eq(autoTopUpControl.singleton, true))
          .limit(1),
        tx
          .select({ id: autoTopUpAttempts.id })
          .from(autoTopUpAttempts)
          .where(
            and(
              eq(autoTopUpAttempts.organization_id, organizationId),
              inArray(autoTopUpAttempts.status, [
                "claimed",
                "payment_pending",
                "payment_succeeded",
                "manual_review",
              ]),
            ),
          )
          .limit(1),
        tx
          .select({ id: autoTopUpLegacyPaymentQuarantine.id })
          .from(autoTopUpLegacyPaymentQuarantine)
          .where(
            and(
              eq(autoTopUpLegacyPaymentQuarantine.organization_id, organizationId),
              inArray(autoTopUpLegacyPaymentQuarantine.status, ["unresolved", "manual_review"]),
            ),
          )
          .limit(1),
      ]);

      const cloudCharacterAggregate = requireAccountBillingAggregateRow(
        cloudCharacterRows,
        "cloud_characters",
      );
      const sandboxAggregate = requireAccountBillingAggregateRow(sandboxRows, "agent_sandboxes");
      const containerAggregate = requireAccountBillingAggregateRow(containerRows, "containers");
      const appAggregate = requireAccountBillingAggregateRow(appRows, "apps");
      const apiKeyAggregate = requireAccountBillingAggregateRow(apiKeyRows, "api_keys");
      const tierSourceCreditAggregate = requireAccountBillingAggregateRow(
        tierSourceCreditRows,
        "tier_source_credits",
      );

      let configuredTier: PrimaryAccountBillingReadModel["configuredTier"];
      try {
        const tierSourceCreditTotal = exactDecimal(
          tierSourceCreditAggregate.tierSourceCreditTotal,
          "tier-source credit total",
        );
        const tierResolution = resolveOrgTierFromSourceValues(
          organizationId,
          tierSourceCreditTotal,
          tierOverride,
        );
        configuredTier = {
          status: "available",
          tier: tierResolution.tierData,
          tierSourceCreditTotal,
          overrides: {
            completionsRpm: tierOverride?.completions_rpm ?? null,
            embeddingsRpm: tierOverride?.embeddings_rpm ?? null,
            standardRpm: tierOverride?.standard_rpm ?? null,
            strictRpm: tierOverride?.strict_rpm ?? null,
          },
        };
      } catch (error) {
        // error-policy:J4 — only typed persisted tier-source corruption is
        // exposed as unavailable; query and programming failures still abort.
        if (
          !(error instanceof ElizaError) ||
          (error.code !== "ORG_RATE_LIMIT_SOURCE_INVALID" &&
            error.code !== "INVALID_ACCOUNT_BILLING_PRIMARY_SOURCE")
        ) {
          throw error;
        }
        configuredTier = { status: "unavailable", code: "configured_tier_invalid" };
      }

      const stripeCustomerIdPresent = Boolean(organization.stripeCustomerId);
      const stripeCustomerIdValid =
        typeof organization.stripeCustomerId === "string" &&
        organization.stripeCustomerId.length > 0 &&
        organization.stripeCustomerId === organization.stripeCustomerId.trim();
      const defaultPaymentMethodIdPresent = Boolean(organization.defaultPaymentMethod);
      const defaultPaymentMethodIdValid =
        typeof organization.defaultPaymentMethod === "string" &&
        organization.defaultPaymentMethod.length > 0 &&
        organization.defaultPaymentMethod === organization.defaultPaymentMethod.trim();

      let customerBindingAuthoritative = false;
      if (stripeCustomerIdValid) {
        const bindingRows = await sqlRows<{ authoritative: unknown }>(
          tx,
          sql`SELECT "stripe_customer_binding_is_authoritative"(
            ${organizationId}::uuid,
            ${organization.stripeCustomerId}::text
          ) AS authoritative`,
        );
        customerBindingAuthoritative = requireCustomerBindingAuthoritativeRow(bindingRows);
      }

      // Consume the existing active-billing selector under this transaction;
      // do not duplicate its billable resource predicate in the snapshot.
      const activeResources = await activeBillingService.listActiveResources(organizationId, tx);
      const activeIds = activeResources.map((resource) => resource.resourceId);
      const rateRows =
        activeIds.length === 0
          ? []
          : await tx
              .select({
                workloadKind: computeBillingRateSegments.workload_kind,
                workloadId: computeBillingRateSegments.workload_id,
                billingState: computeBillingRateSegments.billing_state,
                ratePerHour: computeBillingRateSegments.rate_per_hour,
                effectiveAt: computeBillingRateSegments.effective_at,
              })
              .from(computeBillingRateSegments)
              .where(
                and(
                  eq(computeBillingRateSegments.organization_id, organizationId),
                  inArray(computeBillingRateSegments.workload_id, activeIds),
                  sql`${computeBillingRateSegments.effective_at} <= transaction_timestamp()`,
                ),
              )
              .orderBy(
                desc(computeBillingRateSegments.effective_at),
                desc(computeBillingRateSegments.id),
              );
      const latestRateSegments: PrimaryComputeRateSegment[] = [];
      const seenRates = new Set<string>();
      for (const row of rateRows) {
        const key = `${row.workloadKind}:${row.workloadId}`;
        if (seenRates.has(key)) continue;
        seenRates.add(key);
        latestRateSegments.push(row);
      }

      const control = controlRows[0];

      return {
        observedAt,
        organization: {
          creditBalance: String(organization.creditBalance),
          balanceRevision: exactInteger(
            organization.balanceRevision,
            "organizations.balance_revision",
          ),
          balanceDecreaseRevision: exactInteger(
            organization.balanceDecreaseRevision,
            "organizations.balance_decrease_revision",
          ),
          coveredBalanceDecreaseRevision:
            organization.coveredBalanceDecreaseRevision === null
              ? null
              : exactInteger(
                  organization.coveredBalanceDecreaseRevision,
                  "organizations.auto_top_up_covered_balance_decrease_revision",
                ),
          settings: organization.settings,
          isActive: organization.isActive,
          stripeCustomerIdPresent,
          stripeCustomerIdValid,
          defaultPaymentMethodIdPresent,
          defaultPaymentMethodIdValid,
          autoTopUpEnabled: organization.autoTopUpEnabled === true,
          autoTopUpThreshold:
            organization.autoTopUpThreshold === null
              ? null
              : String(organization.autoTopUpThreshold),
          autoTopUpAmount:
            organization.autoTopUpAmount === null ? null : String(organization.autoTopUpAmount),
        },
        cloudCharacterCount: exactInteger(cloudCharacterAggregate.count, "cloud characters"),
        sandboxCounts: {
          used: exactInteger(sandboxAggregate.used, "used sandboxes"),
          reserved: exactInteger(sandboxAggregate.reserved, "reserved sandboxes"),
          deleting: exactInteger(sandboxAggregate.deleting, "deleting sandboxes"),
        },
        containerCounts: {
          used: exactInteger(containerAggregate.used, "used containers"),
          reserved: exactInteger(containerAggregate.reserved, "reserved containers"),
          deleting: exactInteger(containerAggregate.deleting, "deleting containers"),
        },
        containerSettings: containerConfig?.settings,
        appCount: exactInteger(appAggregate.count, "apps"),
        apiKeyCount: exactInteger(apiKeyAggregate.count, "api keys"),
        storageQuota: storageRows[0]
          ? {
              bytesUsed: String(storageRows[0].bytesUsed),
              bytesLimit: String(storageRows[0].bytesLimit),
            }
          : null,
        configuredTier,
        autoTopUp: {
          control: control
            ? {
                mode: control.mode,
                pausedAt: control.pausedAt,
                legacyReconciledThrough: control.legacyReconciledThrough,
              }
            : null,
          customerBindingAuthoritative,
          blockingAttempt: blockingAttemptRows.length > 0,
          blockingLegacyQuarantine: blockingLegacyRows.length > 0,
        },
        activeResources,
        latestRateSegments,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
