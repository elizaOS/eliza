/**
 * Reads and rebuilds the current organization entitlement projection on the
 * primary database. Rebuilds use revision CAS and lock organization before
 * subscription authority, preserving the billing-domain lock order.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import { dbRead, writeTransaction } from "../helpers";
import {
  type BillingSubscriptionRevision,
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import {
  type NewOrganizationEntitlement,
  type OrganizationEntitlement,
  organizationEntitlements,
} from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export const SUBSCRIPTION_ENTITLEMENT_CONFLICT = "SUBSCRIPTION_ENTITLEMENT_CONFLICT";
export const SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND =
  "SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND";
export const SUBSCRIPTION_ENTITLEMENT_TENANT_NOT_FOUND =
  "SUBSCRIPTION_ENTITLEMENT_TENANT_NOT_FOUND";

type RebuildValues = Omit<
  NewOrganizationEntitlement,
  "organization_id" | "created_at" | "updated_at" | "rebuilt_at" | "projection_revision"
>;

const FREE_ENTITLEMENT_VALUES = {
  completions_rpm: 60,
  embeddings_rpm: 100,
  standard_rpm: 30,
  strict_rpm: 5,
  cloud_characters_ceiling: 5,
  agent_sandboxes_ceiling: 5,
  containers_ceiling: 1,
  storage_gib_ceiling: 5,
  apps_ceiling: 25,
  plan_key: "free",
  state: "free",
  entitlement_effective: true,
  effective_until: null,
  catalog_version: "v1",
  source_subscription_id: null,
  source_subscription_revision: null,
} as const satisfies Omit<RebuildValues, "effective_from" | "source_digest">;

export interface RebuildSubscriptionEntitlementInput {
  organizationId: string;
  expectedProjectionRevision: number | null;
  sourceSubscriptionId: string;
  sourceSubscriptionRevision: number;
}

export interface RebuildSubscriptionEntitlementResult {
  entitlement: OrganizationEntitlement;
  replayed: boolean;
}

function entitlementConflict(message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, {
    code: SUBSCRIPTION_ENTITLEMENT_CONFLICT,
    context,
    severity: "fatal",
  });
}

function sameEntitlementValue(stored: unknown, requested: unknown): boolean {
  if (stored instanceof Date && requested instanceof Date) {
    return stored.getTime() === requested.getTime();
  }
  return stored === (requested ?? null);
}

export function deriveSubscriptionEntitlementValues(
  revision: BillingSubscriptionRevision,
): RebuildValues {
  if (revision.status === "canceled" || revision.status === "incomplete_expired") {
    return {
      ...FREE_ENTITLEMENT_VALUES,
      effective_from: revision.ended_at ?? revision.canceled_at ?? revision.recorded_at,
      source_digest: revision.provider_object_digest,
    };
  }
  if (
    revision.status !== "active" &&
    revision.status !== "grace" &&
    revision.status !== "past_due" &&
    revision.status !== "unpaid"
  ) {
    throw new ElizaError("Subscription revision cannot produce a paid entitlement", {
      code: SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND,
      context: {
        subscriptionId: revision.subscription_id,
        revision: revision.revision,
        status: revision.status,
      },
    });
  }
  const plan = resolveSubscriptionPlanDefinition(revision.plan_key, revision.catalog_version);
  return {
    completions_rpm: plan.rateLimits.completionsRpm,
    embeddings_rpm: plan.rateLimits.embeddingsRpm,
    standard_rpm: plan.rateLimits.standardRpm,
    strict_rpm: plan.rateLimits.strictRpm,
    cloud_characters_ceiling: null,
    agent_sandboxes_ceiling: null,
    containers_ceiling: null,
    storage_gib_ceiling: null,
    apps_ceiling: null,
    plan_key: revision.plan_key,
    state: revision.status,
    entitlement_effective: revision.status === "active" || revision.status === "grace",
    effective_from: revision.current_period_start,
    effective_until: revision.current_period_end,
    catalog_version: revision.catalog_version,
    source_digest: revision.provider_object_digest,
    source_subscription_id: revision.subscription_id,
    source_subscription_revision: revision.revision,
  };
}

export class SubscriptionEntitlementsRepository {
  async find(organizationId: string): Promise<OrganizationEntitlement | undefined> {
    const [row] = await dbRead
      .select()
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organization_id, organizationId))
      .limit(1);
    return row;
  }

  async rebuild(
    input: RebuildSubscriptionEntitlementInput,
  ): Promise<RebuildSubscriptionEntitlementResult> {
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
        .for("update");
      if (!organization) {
        throw new ElizaError("Entitlement organization does not exist", {
          code: SUBSCRIPTION_ENTITLEMENT_TENANT_NOT_FOUND,
          context: { organizationId: input.organizationId },
        });
      }

      let values: RebuildValues;
      {
        const [subscription] = await tx
          .select({ id: billingSubscriptions.id })
          .from(billingSubscriptions)
          .where(
            and(
              eq(billingSubscriptions.organization_id, input.organizationId),
              eq(billingSubscriptions.id, input.sourceSubscriptionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!subscription) {
          throw new ElizaError("Entitlement source subscription does not exist", {
            code: SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND,
            context: {
              organizationId: input.organizationId,
              subscriptionId: input.sourceSubscriptionId,
            },
          });
        }
        const [revision] = await tx
          .select()
          .from(billingSubscriptionRevisions)
          .where(
            and(
              eq(billingSubscriptionRevisions.organization_id, input.organizationId),
              eq(billingSubscriptionRevisions.subscription_id, input.sourceSubscriptionId),
              eq(billingSubscriptionRevisions.revision, input.sourceSubscriptionRevision),
            ),
          )
          .limit(1);
        if (!revision) {
          throw new ElizaError("Entitlement source revision does not exist", {
            code: SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND,
            context: {
              subscriptionId: input.sourceSubscriptionId,
              revision: input.sourceSubscriptionRevision,
            },
          });
        }
        values = deriveSubscriptionEntitlementValues(revision);
      }

      const [current] = await tx
        .select()
        .from(organizationEntitlements)
        .where(eq(organizationEntitlements.organization_id, input.organizationId))
        .limit(1)
        .for("update");
      if (
        current &&
        Object.entries(values).every(([key, requested]) =>
          sameEntitlementValue(current[key as keyof OrganizationEntitlement], requested),
        )
      ) {
        return { entitlement: current, replayed: true };
      }

      const actualRevision = current?.projection_revision ?? null;
      if (actualRevision !== input.expectedProjectionRevision) {
        entitlementConflict("Entitlement projection compare-and-swap failed", {
          organizationId: input.organizationId,
          expectedRevision: input.expectedProjectionRevision,
          actualRevision,
        });
      }
      const nextRevision = (actualRevision ?? -1) + 1;
      const now = await readPostLockDatabaseNow(tx);
      if (!current) {
        const [entitlement] = await tx
          .insert(organizationEntitlements)
          .values({
            ...values,
            organization_id: input.organizationId,
            projection_revision: nextRevision,
            rebuilt_at: now,
            updated_at: now,
          })
          .returning();
        if (!entitlement) {
          entitlementConflict("Entitlement insert returned no row", {
            organizationId: input.organizationId,
          });
        }
        return { entitlement, replayed: false };
      }

      const [entitlement] = await tx
        .update(organizationEntitlements)
        .set({
          ...values,
          projection_revision: nextRevision,
          rebuilt_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(organizationEntitlements.organization_id, input.organizationId),
            eq(organizationEntitlements.projection_revision, input.expectedProjectionRevision!),
          ),
        )
        .returning();
      if (!entitlement) {
        entitlementConflict("Entitlement projection compare-and-swap lost", {
          organizationId: input.organizationId,
          expectedRevision: input.expectedProjectionRevision,
        });
      }
      return { entitlement, replayed: false };
    });
  }
}

export const subscriptionEntitlementsRepository = new SubscriptionEntitlementsRepository();
