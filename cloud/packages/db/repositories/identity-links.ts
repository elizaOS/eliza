import { and, eq, isNull, or, sql } from "drizzle-orm";
import { dbWrite as db } from "@/db/client";
import {
  type IdentityLinkRow as IdentityLinkDbRow,
  type IdentityLinkSource,
  type NewIdentityLink as NewIdentityLinkDbRow,
  identityLinks,
} from "@/db/schemas/identity-links";

export interface IdentityLinkRow {
  id: string;
  organizationId: string;
  userId: string | null;
  leftEntityId: string;
  rightEntityId: string;
  provider: string | null;
  source: IdentityLinkSource;
  createdAt: Date;
}

export interface NewIdentityLink {
  organizationId: string;
  userId?: string | null;
  leftEntityId: string;
  rightEntityId: string;
  provider?: string | null;
  source?: IdentityLinkSource;
}

function toDbInsert(input: NewIdentityLink): NewIdentityLinkDbRow {
  return {
    organization_id: input.organizationId,
    user_id: input.userId ?? null,
    left_entity_id: input.leftEntityId,
    right_entity_id: input.rightEntityId,
    provider: input.provider ?? null,
    source: input.source ?? "manual",
  };
}

function toDomain(row: IdentityLinkDbRow): IdentityLinkRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    leftEntityId: row.left_entity_id,
    rightEntityId: row.right_entity_id,
    provider: row.provider,
    source: row.source,
    createdAt: row.created_at,
  };
}

export class IdentityLinksRepository {
  async link(input: NewIdentityLink): Promise<IdentityLinkRow> {
    const [row] = await db
      .insert(identityLinks)
      .values(toDbInsert(input))
      .onConflictDoUpdate({
        target: [identityLinks.left_entity_id, identityLinks.right_entity_id, identityLinks.provider],
        set: { organization_id: input.organizationId },
      })
      .returning();
    return toDomain(row);
  }

  async unlink(params: {
    leftEntityId: string;
    rightEntityId: string;
    provider?: string | null;
  }): Promise<number> {
    const providerPredicate =
      params.provider === undefined || params.provider === null
        ? isNull(identityLinks.provider)
        : eq(identityLinks.provider, params.provider);

    const rows = await db
      .delete(identityLinks)
      .where(
        and(
          eq(identityLinks.left_entity_id, params.leftEntityId),
          eq(identityLinks.right_entity_id, params.rightEntityId),
          providerPredicate,
        ),
      )
      .returning({ id: identityLinks.id });
    return rows.length;
  }

  async areEntitiesLinked(leftEntityId: string, rightEntityId: string): Promise<boolean> {
    // Symmetric lookup: identity links represent an undirected equivalence.
    const [row] = await db
      .select({ id: identityLinks.id })
      .from(identityLinks)
      .where(
        or(
          and(
            eq(identityLinks.left_entity_id, leftEntityId),
            eq(identityLinks.right_entity_id, rightEntityId),
          ),
          and(
            eq(identityLinks.left_entity_id, rightEntityId),
            eq(identityLinks.right_entity_id, leftEntityId),
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  async listLinkedIdentities(entityId: string): Promise<IdentityLinkRow[]> {
    const rows = await db
      .select()
      .from(identityLinks)
      .where(
        or(
          eq(identityLinks.left_entity_id, entityId),
          eq(identityLinks.right_entity_id, entityId),
        ),
      );
    return rows.map(toDomain);
  }

  async listLinksForUser(organizationId: string, userId: string): Promise<IdentityLinkRow[]> {
    const rows = await db
      .select()
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.organization_id, organizationId),
          eq(identityLinks.user_id, userId),
        ),
      );
    return rows.map(toDomain);
  }

  async countLinks(organizationId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(identityLinks)
      .where(eq(identityLinks.organization_id, organizationId));
    return row?.count ?? 0;
  }
}

export const identityLinksRepository = new IdentityLinksRepository();

export type { IdentityLinkSource };
