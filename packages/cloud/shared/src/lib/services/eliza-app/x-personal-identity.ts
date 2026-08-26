/**
 * Resolves trusted X DM senders to tenant-safe personal accounts and links a
 * verified owner OAuth identity without merging accounts implicitly.
 */
import { ElizaError } from "@elizaos/core/edge";
import { and, eq, or, sql } from "drizzle-orm";
import { dbWrite } from "../../../db/helpers";
import { identityLinks } from "../../../db/schemas/identity-links";
import { type Organization, organizations } from "../../../db/schemas/organizations";
import { type User, users } from "../../../db/schemas/users";

const X_PROVIDER = "x";

function xEntityId(twitterUserId: string): string {
  return `x:${twitterUserId}`;
}

function userEntityId(userId: string): string {
  return `user:${userId}`;
}

function assertTwitterUserId(value: string): string {
  const normalized = value.trim();
  if (!/^\d{1,20}$/.test(normalized)) {
    throw new ElizaError("Trusted X transport supplied an invalid sender id", {
      code: "X_PERSONAL_IDENTITY_INVALID",
      severity: "fatal",
    });
  }
  return normalized;
}

export interface XPersonalAccount {
  user: User;
  organization: Organization;
  isNew: boolean;
}

async function loadAvailableAccount(
  tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
  userId: string,
  expectedOrganizationId?: string,
): Promise<{ user: User; organization: Organization }> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (
    !user ||
    user.deleted_at ||
    !user.is_active ||
    !user.organization_id ||
    (expectedOrganizationId && user.organization_id !== expectedOrganizationId)
  ) {
    throw new ElizaError("X personal account is unavailable", {
      code: "X_PERSONAL_ACCOUNT_UNAVAILABLE",
      context: { userId, expectedOrganizationId },
      severity: "fatal",
    });
  }
  const [organization] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, user.organization_id))
    .limit(1);
  if (!organization?.is_active) {
    throw new ElizaError("X personal account organization is unavailable", {
      code: "X_PERSONAL_ACCOUNT_UNAVAILABLE",
      context: { userId, organizationId: user.organization_id },
      severity: "fatal",
    });
  }
  return { user, organization };
}

/** Resolves a trusted central-bot sender, creating a rowless $0 account once. */
export async function findOrCreateXPersonalAccount(params: {
  twitterUserId: string;
  username?: string;
  displayName?: string;
}): Promise<XPersonalAccount> {
  const twitterUserId = assertTwitterUserId(params.twitterUserId);
  const xEntity = xEntityId(twitterUserId);
  return dbWrite.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`x_personal_identity:${twitterUserId}`}))`,
    );
    const links = await tx
      .select()
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.provider, X_PROVIDER),
          or(eq(identityLinks.left_entity_id, xEntity), eq(identityLinks.right_entity_id, xEntity)),
        ),
      );
    const linkedUserIds = [
      ...new Set(links.flatMap((link) => (link.user_id ? [link.user_id] : []))),
    ];
    if (linkedUserIds.length > 1) {
      throw new ElizaError("X identity has multiple account owners", {
        code: "X_PERSONAL_IDENTITY_CONFLICT",
        context: { twitterUserId },
        severity: "fatal",
      });
    }
    if (linkedUserIds[0]) {
      return { ...(await loadAvailableAccount(tx, linkedUserIds[0])), isNew: false };
    }

    const [organization] = await tx
      .insert(organizations)
      .values({
        name: `${params.displayName?.trim() || params.username?.trim() || "X user"}'s Workspace`,
        slug: `x-${twitterUserId}`,
        credit_balance: "0.00",
      })
      .returning();
    if (!organization) throw new Error("Failed to create X personal organization");
    const [user] = await tx
      .insert(users)
      .values({
        steward_user_id: xEntity,
        name: params.displayName?.trim() || params.username?.trim() || "Eliza user",
        is_anonymous: false,
        organization_id: organization.id,
        role: "owner",
        is_active: true,
      })
      .returning();
    if (!user) throw new Error("Failed to create X personal user");
    await tx.insert(identityLinks).values({
      organization_id: organization.id,
      user_id: user.id,
      left_entity_id: userEntityId(user.id),
      right_entity_id: xEntity,
      provider: X_PROVIDER,
      source: "transport",
    });
    return { user, organization, isNew: true };
  });
}

/**
 * Binds an OAuth-verified owner identity. An X identity already owned by a
 * different account fails closed; account convergence must be explicit.
 */
export async function linkVerifiedXOwnerIdentity(params: {
  organizationId: string;
  userId: string;
  twitterUserId: string;
}): Promise<void> {
  const twitterUserId = assertTwitterUserId(params.twitterUserId);
  const xEntity = xEntityId(twitterUserId);
  await dbWrite.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`x_personal_identity:${twitterUserId}`}))`,
    );
    await loadAvailableAccount(tx, params.userId, params.organizationId);
    const links = await tx
      .select()
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.provider, X_PROVIDER),
          or(eq(identityLinks.left_entity_id, xEntity), eq(identityLinks.right_entity_id, xEntity)),
        ),
      );
    if (links.some((link) => link.user_id !== params.userId)) {
      throw new ElizaError("X identity is already linked to another account", {
        code: "X_PERSONAL_IDENTITY_CONFLICT",
        context: { twitterUserId },
        severity: "fatal",
      });
    }
    await tx
      .insert(identityLinks)
      .values({
        organization_id: params.organizationId,
        user_id: params.userId,
        left_entity_id: userEntityId(params.userId),
        right_entity_id: xEntity,
        provider: X_PROVIDER,
        source: "oauth",
      })
      .onConflictDoUpdate({
        target: [
          identityLinks.left_entity_id,
          identityLinks.right_entity_id,
          identityLinks.provider,
        ],
        set: {
          organization_id: params.organizationId,
          user_id: params.userId,
          source: "oauth",
        },
      });
  });
}
