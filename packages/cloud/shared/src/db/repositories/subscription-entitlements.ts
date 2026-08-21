/**
 * Reads and rebuilds the current organization entitlement projection on the
 * primary database. Rebuilds use revision CAS and lock organization before
 * subscription authority, preserving the billing-domain lock order.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../helpers";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import {
  type NewOrganizationEntitlement,
  type OrganizationEntitlement,
  organizationEntitlements,
} from "../schemas/organization-entitlements";
import { organizations } from "../schemas/organizations";

export const SUBSCRIPTION_ENTITLEMENT_CONFLICT = "SUBSCRIPTION_ENTITLEMENT_CONFLICT";
export const SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND =
  "SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND";
export const SUBSCRIPTION_ENTITLEMENT_TENANT_NOT_FOUND =
  "SUBSCRIPTION_ENTITLEMENT_TENANT_NOT_FOUND";

type RebuildValues = Omit<
  NewOrganizationEntitlement,
  "organization_id" | "created_at" | "updated_at" | "rebuilt_at" | "projection_revision"
>;

export interface RebuildSubscriptionEntitlementInput {
  organizationId: string;
  expectedProjectionRevision: number | null;
  values: RebuildValues;
  rebuiltAt?: Date;
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

      if (input.values.source_subscription_id != null) {
        const [subscription] = await tx
          .select({ id: billingSubscriptions.id })
          .from(billingSubscriptions)
          .where(
            and(
              eq(billingSubscriptions.organization_id, input.organizationId),
              eq(billingSubscriptions.id, input.values.source_subscription_id),
            ),
          )
          .limit(1)
          .for("update");
        if (!subscription || input.values.source_subscription_revision == null) {
          throw new ElizaError("Entitlement source subscription does not exist", {
            code: SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND,
            context: {
              organizationId: input.organizationId,
              subscriptionId: input.values.source_subscription_id,
            },
          });
        }
        const [revision] = await tx
          .select({ id: billingSubscriptionRevisions.id })
          .from(billingSubscriptionRevisions)
          .where(
            and(
              eq(billingSubscriptionRevisions.organization_id, input.organizationId),
              eq(billingSubscriptionRevisions.subscription_id, input.values.source_subscription_id),
              eq(billingSubscriptionRevisions.revision, input.values.source_subscription_revision),
            ),
          )
          .limit(1);
        if (!revision) {
          throw new ElizaError("Entitlement source revision does not exist", {
            code: SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND,
            context: {
              subscriptionId: input.values.source_subscription_id,
              revision: input.values.source_subscription_revision,
            },
          });
        }
      }

      const [current] = await tx
        .select()
        .from(organizationEntitlements)
        .where(eq(organizationEntitlements.organization_id, input.organizationId))
        .limit(1)
        .for("update");
      if (
        current &&
        current.source_digest === input.values.source_digest &&
        current.catalog_version === input.values.catalog_version &&
        current.source_subscription_id === (input.values.source_subscription_id ?? null) &&
        current.source_subscription_revision === (input.values.source_subscription_revision ?? null)
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
      const now = input.rebuiltAt ?? new Date();
      if (!current) {
        const [entitlement] = await tx
          .insert(organizationEntitlements)
          .values({
            ...input.values,
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
          ...input.values,
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
