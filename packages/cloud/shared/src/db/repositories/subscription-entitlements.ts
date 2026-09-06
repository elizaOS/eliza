/**
 * Reads and rebuilds the current organization entitlement projection on the
 * primary database. Rebuilds use revision CAS and lock organization before
 * subscription authority, preserving the billing-domain lock order.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { resolveSubscriptionPlanDefinition } from "../../lib/services/subscription-catalog";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
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
      source_subscription_id: revision.subscription_id,
      source_subscription_revision: revision.revision,
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
  const effectiveUntil =
    revision.status === "grace" ? revision.grace_expires_at : revision.current_period_end;
  if (
    effectiveUntil === null ||
    !Number.isFinite(effectiveUntil.getTime()) ||
    !Number.isFinite(revision.current_period_start.getTime()) ||
    effectiveUntil <= revision.current_period_start
  ) {
    throw new ElizaError("Subscription entitlement requires a valid lifecycle deadline", {
      code: SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND,
      context: { subscriptionId: revision.subscription_id, status: revision.status },
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
    effective_until: effectiveUntil,
    catalog_version: revision.catalog_version,
    source_digest: revision.provider_object_digest,
    source_subscription_id: revision.subscription_id,
    source_subscription_revision: revision.revision,
  };
}

export class SubscriptionEntitlementsRepository {
  async find(organizationId: string): Promise<OrganizationEntitlement | undefined> {
    const [row] = await dbWrite
      .select()
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organization_id, organizationId))
      .limit(1);
    return row;
  }

  async rebuild(
    input: RebuildSubscriptionEntitlementInput,
  ): Promise<RebuildSubscriptionEntitlementResult> {
    return writeTransaction((tx) => this.rebuildInTransaction(tx, input));
  }

  /** Compose publication with lifecycle writes; the transaction owns organization-first locks. */
  async rebuildInTransaction(
    tx: DbTransaction,
    input: RebuildSubscriptionEntitlementInput,
  ): Promise<RebuildSubscriptionEntitlementResult> {
    const [organization] = await tx
      .select({
        id: organizations.id,
        subscriptionAuthorityId: organizations.subscription_authority_id,
        subscriptionAuthorityState: organizations.subscription_authority_state,
      })
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
        .select()
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
      if (subscription.lifecycle_revision !== input.sourceSubscriptionRevision) {
        entitlementConflict("Entitlement source is not the current lifecycle revision", {
          organizationId: input.organizationId,
          subscriptionId: subscription.id,
          requestedRevision: input.sourceSubscriptionRevision,
          currentRevision: subscription.lifecycle_revision,
        });
      }
      if (
        organization.subscriptionAuthorityState !== "current" ||
        organization.subscriptionAuthorityId !== subscription.id
      ) {
        entitlementConflict(
          "Entitlement source is not the current account subscription authority",
          {
            organizationId: input.organizationId,
            subscriptionId: subscription.id,
            authorityState: organization.subscriptionAuthorityState,
          },
        );
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
      for (const field of [
        "plan_key",
        "catalog_version",
        "status",
        "current_period_start",
        "current_period_end",
        "grace_expires_at",
        "provider_object_digest",
        "canceled_at",
        "ended_at",
      ] as const) {
        if (!sameEntitlementValue(subscription[field], revision[field])) {
          entitlementConflict("Entitlement source differs from committed lifecycle authority", {
            organizationId: input.organizationId,
            subscriptionId: subscription.id,
            field,
          });
        }
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
  }
}

export const subscriptionEntitlementsRepository = new SubscriptionEntitlementsRepository();
