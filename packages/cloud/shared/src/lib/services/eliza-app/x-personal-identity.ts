/**
 * Resolves X DM senders from an allowlisted platform DM router to personal
 * accounts and links a verified owner OAuth identity without merging accounts
 * implicitly.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { dbWrite } from "../../../db/helpers";
import { identityLinks } from "../../../db/schemas/identity-links";
import { type Organization, organizations } from "../../../db/schemas/organizations";
import { type User, users } from "../../../db/schemas/users";
import { SIGNUP_CREDIT_POLICY } from "../../signup-credits";

const X_PROVIDER = "x";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Organizations allowed to deliver X personal DMs, from the comma-separated
 * X_PERSONAL_DM_ROUTER_ORG_IDS. Body-supplied sender ids are trusted only from
 * these callers. Unset or empty allows nobody.
 */
export function xPersonalDmRouterOrgIds(env: Record<string, unknown>): Set<string> {
  const raw = env.X_PERSONAL_DM_ROUTER_ORG_IDS;
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID_PATTERN.test(id)),
  );
}

export function isXPersonalDmRouterOrg(
  env: Record<string, unknown>,
  organizationId: string,
): boolean {
  return xPersonalDmRouterOrgIds(env).has(organizationId.trim().toLowerCase());
}

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

/**
 * Resolves an X DM sender, creating one personal account when none is linked.
 * The sender id is trusted only because the caller is an allowlisted DM router.
 */
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
        credit_balance: SIGNUP_CREDIT_POLICY.openingBalanceUsd,
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
 * True when another account holds this X id only through transport links and
 * shows no owner activity: it was created by a DM delivery, has no credits and
 * no other identity link. Such an account may have been created from a spoofed
 * sender id, so a verified owner OAuth link takes the X id over.
 */
async function isSupersedableTransportAccount(
  tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
  userId: string,
  xEntity: string,
): Promise<boolean> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.steward_user_id !== xEntity || !user.organization_id) return false;
  const [organization] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, user.organization_id))
    .limit(1);
  if (!organization || Number(organization.credit_balance) > 0) return false;
  const userLinks = await tx.select().from(identityLinks).where(eq(identityLinks.user_id, userId));
  return userLinks.every(
    (link) =>
      link.source === "transport" &&
      link.provider === X_PROVIDER &&
      (link.left_entity_id === xEntity || link.right_entity_id === xEntity),
  );
}

/**
 * Binds an OAuth-verified owner identity. An X identity already owned by a
 * different account fails closed; account convergence must be explicit. The
 * one exception is an unfunded transport-only account with no owner activity,
 * whose transport links the verified owner replaces.
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
    const foreignLinks = links.filter((link) => link.user_id !== params.userId);
    const foreignUserIds = [
      ...new Set(foreignLinks.flatMap((link) => (link.user_id ? [link.user_id] : []))),
    ];
    let supersedable =
      foreignLinks.every((link) => link.source === "transport" && link.user_id) &&
      foreignUserIds.length === 1;
    if (supersedable && foreignUserIds[0]) {
      supersedable = await isSupersedableTransportAccount(tx, foreignUserIds[0], xEntity);
    }
    if (foreignLinks.length > 0 && !supersedable) {
      throw new ElizaError("X identity is already linked to another account", {
        code: "X_PERSONAL_IDENTITY_CONFLICT",
        context: { twitterUserId },
        severity: "fatal",
      });
    }
    if (foreignLinks.length > 0) {
      await tx.delete(identityLinks).where(
        inArray(
          identityLinks.id,
          foreignLinks.map((link) => link.id),
        ),
      );
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
