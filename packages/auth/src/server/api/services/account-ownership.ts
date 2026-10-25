import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { accounts, getDb, users, userTenants } from "../../db/index";

export async function activeTenantOwnerCount(
  tx: Pick<ReturnType<typeof getDb>, "select">,
  tenantId: string,
  excludeUserId?: string,
): Promise<number> {
  const conditions = [
    eq(userTenants.tenantId, tenantId),
    eq(userTenants.role, "owner"),
    isNull(users.deactivatedAt),
  ];
  if (excludeUserId) conditions.push(ne(userTenants.userId, excludeUserId));
  const [ownerCount] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(userTenants)
    .innerJoin(users, eq(users.id, userTenants.userId))
    .where(and(...conditions));
  return Number(ownerCount?.count ?? 0);
}

export async function userHasLinkedThirdPartyWallet(
  userId: string,
): Promise<boolean> {
  const [linkedWallet] = await getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        or(
          eq(accounts.provider, "wallet:ethereum"),
          eq(accounts.provider, "wallet:solana"),
        ),
      ),
    )
    .limit(1);
  return Boolean(linkedWallet);
}
