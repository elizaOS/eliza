/**
 * Resolves X DM senders reported by the allowlisted platform DM router to
 * tenant-safe personal accounts and links a verified owner OAuth identity
 * without merging accounts implicitly.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { dbWrite } from "../../../db/helpers";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import { type IdentityLinkRow, identityLinks } from "../../../db/schemas/identity-links";
import { type Organization, organizations } from "../../../db/schemas/organizations";
import { type User, users } from "../../../db/schemas/users";
import { SIGNUP_CREDIT_POLICY } from "../../signup-credits";

const X_PROVIDER = "x";

function xEntityId(twitterUserId: string): string {
  return `x:${twitterUserId}`;
}

function userEntityId(userId: string): string {
  return `user:${userId}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Organizations allowed to report X DM senders: the platform DM router only.
 * Read from X_PERSONAL_DM_ROUTER_ORG_IDS (comma-separated UUIDs); unset or
 * empty allows nobody.
 */
export function xPersonalDmRouterOrgIds(env: {
  readonly [key: string]: unknown;
}): ReadonlySet<string> {
  const raw = env.X_PERSONAL_DM_ROUTER_ORG_IDS;
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID_PATTERN.test(id)),
  );
}

function assertTwitterUserId(value: string): string {
  const normalized = value.trim();
  if (!/^\d{1,20}$/.test(normalized)) {
    throw new ElizaError("X DM router supplied an invalid sender id", {
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
 * Resolves an X DM sender, creating one unfunded personal account. The sender
 * id is trusted only because the caller is an allowlisted platform DM router.
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
 * True when the X identity is held only by a DM-created account its owner
 * never used: transport links only, no credits or ledger rows, no other
 * linked identity and no sign-in other than the X transport id. Such an
 * account may have been created from a forged sender id, so a verified
 * owner OAuth link supersedes it.
 */
async function isUnclaimedTransportAccount(
  tx: Parameters<Parameters<typeof dbWrite.transaction>[0]>[0],
  foreignLinks: IdentityLinkRow[],
  xEntity: string,
): Promise<boolean> {
  if (foreignLinks.some((link) => link.source !== "transport")) return false;
  const userIds = [
    ...new Set(foreignLinks.flatMap((link) => (link.user_id ? [link.user_id] : []))),
  ];
  if (userIds.length > 1) return false;
  const userId = userIds[0];
  if (!userId) return true;
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return true;
  if (user.steward_user_id !== xEntity || !user.organization_id) return false;
  const [organization] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, user.organization_id))
    .limit(1);
  if (organization && Number(organization.credit_balance) !== 0) return false;
  const [ledgerRow] = await tx
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(eq(creditTransactions.organization_id, user.organization_id))
    .limit(1);
  if (ledgerRow) return false;
  const [otherLink] = await tx
    .select({ id: identityLinks.id })
    .from(identityLinks)
    .where(and(eq(identityLinks.user_id, userId), ne(identityLinks.source, "transport")))
    .limit(1);
  return !otherLink;
}

/**
 * Binds an OAuth-verified owner identity. An X identity already owned by a
 * different account fails closed unless that account is an unclaimed
 * DM-created one; account convergence must otherwise be explicit.
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
    if (foreignLinks.length > 0) {
      if (!(await isUnclaimedTransportAccount(tx, foreignLinks, xEntity))) {
        throw new ElizaError("X identity is already linked to another account", {
          code: "X_PERSONAL_IDENTITY_CONFLICT",
          context: { twitterUserId },
          severity: "fatal",
        });
      }
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
