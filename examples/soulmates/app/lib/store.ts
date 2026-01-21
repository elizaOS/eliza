import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import type { AllowlistRow, CreditLedgerRow, UserRow } from "@/lib/db";
import {
  allowlistTable,
  creditLedgerTable,
  getDatabase,
  usersTable,
} from "@/lib/db";
import { readCsvEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/phone";

export type UserStatus = "active" | "pending" | "blocked";

export type UserRecord = {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  location: string | null;
  credits: number;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserCursor = {
  createdAt: string;
  id: string;
};

export type UserListQuery = {
  q?: string;
  status?: UserStatus;
  isAdmin?: boolean;
  limit?: number;
  createdAfter?: string;
  createdBefore?: string;
  cursor?: UserCursor | null;
};

export type UserListResult = {
  items: UserRecord[];
  total: number;
  nextCursor: UserCursor | null;
};

export type AllowlistEntry = {
  phone: string;
  addedAt: string;
  addedBy: string | null;
};

export type CreditLedgerReason =
  | "topup"
  | "admin_adjustment"
  | "spend_priority_match"
  | "spend_priority_schedule"
  | "spend_filters"
  | "spend_insight";

export type CreditLedgerEntry = {
  id: string;
  userId: string;
  delta: number;
  balance: number;
  reason: CreditLedgerReason;
  reference: string | null;
  createdAt: string;
};

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  phone: row.phone,
  name: row.name,
  email: row.email,
  location: row.location,
  credits: row.credits,
  status: row.status as UserStatus,
  isAdmin: row.isAdmin,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const toAllowlist = (row: AllowlistRow): AllowlistEntry => ({
  phone: row.phone,
  addedAt: row.addedAt.toISOString(),
  addedBy: row.addedBy,
});

const toLedger = (row: CreditLedgerRow): CreditLedgerEntry => ({
  id: row.id,
  userId: row.userId,
  delta: row.delta,
  balance: row.balance,
  reason: row.reason as "topup" | "admin_adjustment",
  reference: row.reference,
  createdAt: row.createdAt.toISOString(),
});

function parsePhoneList(envKey: string): string[] {
  return [
    ...new Set(
      readCsvEnv(envKey)
        .map(normalizePhone)
        .filter((p): p is string => p !== null),
    ),
  ];
}

export function getAdminPhones(): string[] {
  return parsePhoneList("SOULMATES_ADMIN_PHONES");
}

let allowlistSeeded = false;

async function ensureAllowlistSeeded(): Promise<void> {
  if (allowlistSeeded) return;

  const db = await getDatabase();
  const phones = [
    ...new Set([
      ...parsePhoneList("SOULMATES_ALLOWLIST_PHONES"),
      ...getAdminPhones(),
    ]),
  ];

  for (const phone of phones) {
    await db.insert(allowlistTable).values({ phone }).onConflictDoNothing();
  }

  allowlistSeeded = true;
}

export function resetAllowlistSeedState(): void {
  allowlistSeeded = false;
}

async function reconcileUserStatus(user: UserRow): Promise<UserStatus> {
  if (user.status === "blocked") return "blocked";
  return "active";
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const db = await getDatabase();
  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  if (!row) return null;

  const status = await reconcileUserStatus(row);
  if (status !== row.status) {
    await db
      .update(usersTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(usersTable.id, id));
    row.status = status;
  }
  return toUser(row);
}

export async function getUserByPhone(
  phone: string,
): Promise<UserRecord | null> {
  const db = await getDatabase();
  const [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, phone))
    .limit(1);
  if (!row) return null;

  const status = await reconcileUserStatus(row);
  if (status !== row.status) {
    await db
      .update(usersTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(usersTable.id, row.id));
    row.status = status;
  }
  return toUser(row);
}

export async function upsertUserByPhone(
  phone: string,
  updates: {
    name?: string | null;
    email?: string | null;
    location?: string | null;
    status?: UserStatus;
    isAdmin?: boolean;
  },
): Promise<UserRecord> {
  const db = await getDatabase();
  const adminPhones = getAdminPhones();
  const isAdmin = updates.isAdmin ?? adminPhones.includes(phone);

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, phone))
    .limit(1);

  if (existing) {
    const status =
      updates.status ?? (existing.status === "blocked" ? "blocked" : "active");

    await db
      .update(usersTable)
      .set({
        name: updates.name ?? existing.name,
        email: updates.email ?? existing.email,
        location: updates.location ?? existing.location,
        isAdmin,
        status,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, existing.id));

    const [updated] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, existing.id))
      .limit(1);
    return toUser(updated);
  }

  const [created] = await db
    .insert(usersTable)
    .values({
      phone,
      name: updates.name ?? null,
      email: updates.email ?? null,
      location: updates.location ?? null,
      status: updates.status ?? "active",
      isAdmin,
    })
    .returning();

  return toUser(created);
}

export async function updateUserProfile(
  userId: string,
  updates: {
    name?: string | null;
    email?: string | null;
    location?: string | null;
  },
): Promise<UserRecord | null> {
  const db = await getDatabase();
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!existing) return null;

  await db
    .update(usersTable)
    .set({
      name: updates.name ?? existing.name,
      email: updates.email ?? existing.email,
      location: updates.location ?? existing.location,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, userId));

  const [updated] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return toUser(updated);
}

export async function updateUserAdminFields(
  userId: string,
  updates: { status?: UserStatus; isAdmin?: boolean },
): Promise<UserRecord | null> {
  const db = await getDatabase();
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!existing) return null;

  const nextStatus =
    updates.status ?? (existing.status === "blocked" ? "blocked" : "active");
  const nextAdmin = updates.isAdmin ?? existing.isAdmin;

  await db
    .update(usersTable)
    .set({
      status: nextStatus,
      isAdmin: nextAdmin,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, existing.id));

  const [updated] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, existing.id))
    .limit(1);
  return updated ? toUser(updated) : null;
}

export async function listUsers(): Promise<UserRecord[]> {
  const db = await getDatabase();
  const rows = await db.select().from(usersTable);
  return rows.map(toUser);
}

export async function listUsersPage(
  query: UserListQuery,
): Promise<UserListResult> {
  const db = await getDatabase();
  const limit = clamp(query.limit ?? 50, 1, 200);
  const conditions = [];

  if (query.status) {
    conditions.push(eq(usersTable.status, query.status));
  }
  if (query.isAdmin !== undefined) {
    conditions.push(eq(usersTable.isAdmin, query.isAdmin));
  }
  if (query.q) {
    const term = `%${query.q.trim()}%`;
    conditions.push(
      or(
        ilike(usersTable.phone, term),
        ilike(usersTable.name, term),
        ilike(usersTable.email, term),
      ),
    );
  }
  if (query.createdAfter) {
    const createdAfter = new Date(query.createdAfter);
    if (Number.isFinite(createdAfter.getTime())) {
      conditions.push(gte(usersTable.createdAt, createdAfter));
    }
  }
  if (query.createdBefore) {
    const createdBefore = new Date(query.createdBefore);
    if (Number.isFinite(createdBefore.getTime())) {
      conditions.push(lt(usersTable.createdAt, createdBefore));
    }
  }
  if (query.cursor) {
    const cursorDate = new Date(query.cursor.createdAt);
    if (Number.isFinite(cursorDate.getTime())) {
      conditions.push(
        or(
          lt(usersTable.createdAt, cursorDate),
          and(
            eq(usersTable.createdAt, cursorDate),
            lt(usersTable.id, query.cursor.id),
          ),
        ),
      );
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const totalRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(usersTable)
    .where(whereClause);
  const total = totalRow.length > 0 ? Number(totalRow[0].count) : 0;

  const rows = await db
    .select()
    .from(usersTable)
    .where(whereClause)
    .orderBy(desc(usersTable.createdAt), desc(usersTable.id))
    .limit(limit);

  const items = rows.map(toUser);
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last
      ? { createdAt: last.createdAt.toISOString(), id: last.id }
      : null;

  return { items, total, nextCursor };
}

export async function getAllowlist(): Promise<AllowlistEntry[]> {
  await ensureAllowlistSeeded();
  const db = await getDatabase();
  const rows = await db.select().from(allowlistTable);
  return rows.map(toAllowlist);
}

export async function setAllowlist(
  phone: string,
  allow: boolean,
  actorId: string | null,
): Promise<AllowlistEntry[]> {
  await ensureAllowlistSeeded();
  const db = await getDatabase();

  if (allow) {
    await db
      .insert(allowlistTable)
      .values({ phone, addedBy: actorId })
      .onConflictDoNothing();
  } else {
    await db.delete(allowlistTable).where(eq(allowlistTable.phone, phone));
  }

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, phone));
  for (const user of users) {
    if (user.status !== "blocked") {
      await db
        .update(usersTable)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(usersTable.id, user.id));
    }
  }

  return getAllowlist();
}

export async function addCredits(
  userId: string,
  delta: number,
  reason: "topup" | "admin_adjustment",
  reference: string | null,
): Promise<UserRecord | null> {
  const db = await getDatabase();

  if (reference) {
    const [existing] = await db
      .select()
      .from(creditLedgerTable)
      .where(
        and(
          eq(creditLedgerTable.reference, reference),
          eq(creditLedgerTable.reason, reason),
        ),
      )
      .limit(1);
    if (existing) {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      return user ? toUser(user) : null;
    }
  }

  const result = await db
    .update(usersTable)
    .set({
      credits: sql`GREATEST(0, ${usersTable.credits} + ${delta})`,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, userId))
    .returning();

  if (result.length === 0) return null;

  const updatedUser = result[0];
  await db.insert(creditLedgerTable).values({
    userId,
    delta,
    balance: updatedUser.credits,
    reason,
    reference,
  });

  return toUser(updatedUser);
}

export async function spendCredits(
  userId: string,
  amount: number,
  reason: Exclude<CreditLedgerReason, "topup" | "admin_adjustment">,
  reference: string | null,
): Promise<UserRecord | null> {
  const db = await getDatabase();
  if (!Number.isFinite(amount) || amount <= 0) return null;

  if (reference) {
    const [existing] = await db
      .select()
      .from(creditLedgerTable)
      .where(
        and(
          eq(creditLedgerTable.reference, reference),
          eq(creditLedgerTable.reason, reason),
        ),
      )
      .limit(1);
    if (existing) {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      return user ? toUser(user) : null;
    }
  }

  const result = await db
    .update(usersTable)
    .set({
      credits: sql`GREATEST(0, ${usersTable.credits} - ${amount})`,
      updatedAt: new Date(),
    })
    .where(and(eq(usersTable.id, userId), gte(usersTable.credits, amount)))
    .returning();

  if (result.length === 0) return null;

  const updatedUser = result[0];
  await db.insert(creditLedgerTable).values({
    userId,
    delta: -amount,
    balance: updatedUser.credits,
    reason,
    reference,
  });

  return toUser(updatedUser);
}

export async function listCreditLedger(
  userId: string,
): Promise<CreditLedgerEntry[]> {
  const db = await getDatabase();
  const rows = await db
    .select()
    .from(creditLedgerTable)
    .where(eq(creditLedgerTable.userId, userId));
  return rows.map(toLedger);
}
