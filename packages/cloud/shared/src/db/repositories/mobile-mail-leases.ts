/** Persistence for the native mail and calendar lease issued with mobile App Auth. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, exists, gt, isNull, or, type SQL } from "drizzle-orm";
import { type DbTransaction, dbWrite } from "../client";
import { decryptField, type EncryptedField, encryptField } from "../crypto/field-crypto";
import { apiKeys } from "../schemas/api-keys";
import { apps } from "../schemas/apps";
import { type MobileAppAuthGrant, mobileAppAuthGrants } from "../schemas/mobile-app-auth-grants";
import { mobileMailLeases, spentMobileMailRefreshes } from "../schemas/mobile-mail-leases";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";

export const MAIL_LEASE_ACCESS_SECONDS = 15 * 60;
export const MAIL_LEASE_IDLE_SECONDS = 90 * 24 * 60 * 60;
export const MAIL_LEASE_ACCESS_PATTERN = /^eliza_lease_[A-Za-z0-9_-]{43}$/u;
export const MAIL_LEASE_REFRESH_PATTERN = /^eliza_lease_refresh_[A-Za-z0-9_-]{54}$/u;

export interface InitialMobileMailLease {
  readonly refresh: string;
  readonly refreshExpiresIn: number;
}

export interface PreparedMobileMailLease {
  readonly id: string;
  readonly refreshHash: string;
  readonly delivery: EncryptedField;
}

export interface MobileMailLeasePrincipal {
  readonly userId: string;
  readonly organizationId: string;
  readonly credentialId: string;
  readonly sessionId: string;
  readonly appId: string;
  readonly leaseId: string;
}

export interface RotatedMobileMailLease extends InitialMobileMailLease {
  readonly access: string;
  readonly accessExpiresIn: number;
}

type Lease = typeof mobileMailLeases.$inferSelect;

type MailLeaseGrant = Pick<
  MobileAppAuthGrant,
  "id" | "session_id" | "credential_id" | "renewed_from_credential_id"
>;

export function mailLeaseTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newMailLeaseRefresh(): string {
  return `eliza_lease_refresh_${randomBytes(40).toString("base64url")}`;
}

function initialDelivery(id: string) {
  return { table: "mobile_mail_leases", rowId: id, column: "initial_delivery" };
}

export async function prepareMobileMailLease(
  organizationId: string,
): Promise<PreparedMobileMailLease> {
  const id = randomUUID();
  const refresh = newMailLeaseRefresh();
  return {
    id,
    refreshHash: mailLeaseTokenHash(refresh),
    delivery: await encryptField(organizationId, refresh, initialDelivery(id)),
  };
}

/** The caller has just claimed the initial PKCE grant and created its inactive key in this transaction. */
export async function insertMobileMailLease(
  tx: DbTransaction,
  grant: MailLeaseGrant,
  prepared: PreparedMobileMailLease,
  now: Date,
): Promise<void> {
  if (grant.renewed_from_credential_id || !grant.credential_id) {
    throw new Error("The mail lease requires an initial mobile exchange");
  }
  await tx.insert(mobileMailLeases).values({
    id: prepared.id,
    session_id: grant.session_id ?? grant.id,
    credential_id: grant.credential_id,
    refresh_hash: prepared.refreshHash,
    idle_expires_at: new Date(now.getTime() + MAIL_LEASE_IDLE_SECONDS * 1000),
    initial_delivery: prepared.delivery,
  });
}

/** Retry delivery only from the same successfully checked PKCE exchange. */
export async function readInitialMobileMailLease(
  grant: MailLeaseGrant,
  now: Date,
): Promise<InitialMobileMailLease | undefined> {
  if (grant.renewed_from_credential_id || !grant.credential_id) return undefined;
  const [lease] = await dbWrite
    .select()
    .from(mobileMailLeases)
    .where(
      and(
        eq(mobileMailLeases.session_id, grant.session_id ?? grant.id),
        eq(mobileMailLeases.credential_id, grant.credential_id),
        isNull(mobileMailLeases.revoked_at),
        gt(mobileMailLeases.idle_expires_at, now),
      ),
    )
    .limit(1);
  if (!lease?.initial_delivery) return undefined;
  const refresh = await decryptField(lease.initial_delivery, initialDelivery(lease.id));
  if (
    !MAIL_LEASE_REFRESH_PATTERN.test(refresh) ||
    mailLeaseTokenHash(refresh) !== lease.refresh_hash
  ) {
    throw new Error("Stored mobile mail lease failed integrity checks");
  }
  return {
    refresh,
    refreshExpiresIn: Math.floor((lease.idle_expires_at.getTime() - now.getTime()) / 1000),
  };
}

/** Move an existing lease to the acknowledged successor within the key acknowledgement transaction. */
export async function acknowledgeMobileMailLease(
  tx: DbTransaction,
  grant: MailLeaseGrant,
  credentialId: string,
): Promise<void> {
  await tx
    .update(mobileMailLeases)
    .set({ credential_id: credentialId, initial_delivery: null })
    .where(
      and(
        eq(mobileMailLeases.session_id, grant.session_id ?? grant.id),
        eq(mobileMailLeases.credential_id, grant.renewed_from_credential_id ?? credentialId),
        isNull(mobileMailLeases.revoked_at),
      ),
    );
}

async function currentLease(tx: DbTransaction, tokenMatch: SQL | undefined) {
  const [row] = await tx
    .select({
      lease: mobileMailLeases,
      userId: users.id,
      organizationId: organizations.id,
      appId: apps.id,
    })
    .from(mobileMailLeases)
    .innerJoin(apiKeys, eq(apiKeys.id, mobileMailLeases.credential_id))
    .innerJoin(mobileAppAuthGrants, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
    .innerJoin(apps, eq(apps.id, mobileAppAuthGrants.app_id))
    .innerJoin(users, eq(users.id, mobileAppAuthGrants.user_id))
    .innerJoin(organizations, eq(organizations.id, mobileAppAuthGrants.organization_id))
    .where(
      and(
        tokenMatch,
        eq(mobileAppAuthGrants.status, "acknowledged"),
        eq(mobileAppAuthGrants.session_id, mobileMailLeases.session_id),
        eq(apiKeys.user_id, users.id),
        eq(apiKeys.organization_id, organizations.id),
        eq(apiKeys.source_app_id, apps.id),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
        eq(users.is_active, true),
        eq(users.organization_id, organizations.id),
        eq(organizations.is_active, true),
        eq(organizations.account_lifecycle_state, "active"),
        isNull(organizations.account_deletion_request_id),
        eq(apps.is_active, true),
        eq(apps.is_approved, true),
      ),
    )
    .limit(1)
    .for("update", { of: mobileMailLeases });
  return row;
}

function live(lease: Lease, now: Date): boolean {
  return !lease.revoked_at && lease.initial_delivery === null && lease.idle_expires_at > now;
}

function idleDeadline(now: Date): Date {
  return new Date(now.getTime() + MAIL_LEASE_IDLE_SECONDS * 1000);
}

async function keepOffer(tx: DbTransaction, lease: Lease, now: Date): Promise<Lease> {
  const { offered_refresh_hash, offered_access_hash, offered_access_expires_at } = lease;
  if (!offered_refresh_hash || !offered_access_hash || !offered_access_expires_at) {
    throw new Error("Stored mobile mail lease offer is incomplete");
  }
  await tx
    .insert(spentMobileMailRefreshes)
    .values({ lease_id: lease.id, refresh_hash: lease.refresh_hash });
  const [current] = await tx
    .update(mobileMailLeases)
    .set({
      refresh_hash: offered_refresh_hash,
      access_hash: offered_access_hash,
      access_expires_at: offered_access_expires_at,
      idle_expires_at: idleDeadline(now),
      offered_refresh_hash: null,
      offered_access_hash: null,
      offered_access_expires_at: null,
      offered_delivery: null,
    })
    .where(eq(mobileMailLeases.id, lease.id))
    .returning();
  if (!current) throw new Error("The mobile mail lease disappeared during rotation");
  return current;
}

function principal(row: {
  lease: Lease;
  userId: string;
  organizationId: string;
  appId: string;
}): MobileMailLeasePrincipal {
  return {
    userId: row.userId,
    organizationId: row.organizationId,
    credentialId: row.lease.credential_id,
    sessionId: row.lease.session_id,
    appId: row.appId,
    leaseId: row.lease.id,
  };
}

export async function admitMobileMailAccess(
  access: string,
  now = new Date(),
): Promise<MobileMailLeasePrincipal | null> {
  if (!MAIL_LEASE_ACCESS_PATTERN.test(access)) return null;
  const hash = mailLeaseTokenHash(access);
  return await dbWrite.transaction(async (tx) => {
    const row = await currentLease(
      tx,
      or(eq(mobileMailLeases.access_hash, hash), eq(mobileMailLeases.offered_access_hash, hash)),
    );
    if (!row || !live(row.lease, now)) return null;
    const expiry =
      row.lease.offered_access_hash === hash
        ? row.lease.offered_access_expires_at
        : row.lease.access_expires_at;
    if (!expiry || expiry <= now) return null;
    if (row.lease.offered_access_hash === hash) await keepOffer(tx, row.lease, now);
    return principal(row);
  });
}

type Rotation =
  | { kind: "offered"; tokens: RotatedMobileMailLease; principal: MobileMailLeasePrincipal }
  | { kind: "reused"; principal: MobileMailLeasePrincipal }
  | { kind: "invalid" };

function spentRefresh(tx: DbTransaction, hash: string) {
  return tx
    .select({ hash: spentMobileMailRefreshes.refresh_hash })
    .from(spentMobileMailRefreshes)
    .where(
      and(
        eq(spentMobileMailRefreshes.lease_id, mobileMailLeases.id),
        eq(spentMobileMailRefreshes.refresh_hash, hash),
      ),
    );
}

function offerDelivery(id: string) {
  return { table: "mobile_mail_leases", rowId: id, column: "offered_delivery" };
}

async function revealOffer(lease: Lease, now: Date): Promise<RotatedMobileMailLease> {
  if (!lease.offered_delivery || !lease.offered_access_expires_at) {
    throw new Error("Stored mobile mail lease offer is incomplete");
  }
  const tokens: Partial<Pick<RotatedMobileMailLease, "access" | "refresh">> = JSON.parse(
    await decryptField(lease.offered_delivery, offerDelivery(lease.id)),
  );
  if (
    typeof tokens.access !== "string" ||
    typeof tokens.refresh !== "string" ||
    !MAIL_LEASE_ACCESS_PATTERN.test(tokens.access) ||
    !MAIL_LEASE_REFRESH_PATTERN.test(tokens.refresh) ||
    mailLeaseTokenHash(tokens.access) !== lease.offered_access_hash ||
    mailLeaseTokenHash(tokens.refresh) !== lease.offered_refresh_hash
  ) {
    throw new Error("Stored mobile mail lease offer failed integrity checks");
  }
  return {
    access: tokens.access,
    refresh: tokens.refresh,
    accessExpiresIn: Math.max(
      0,
      Math.floor((lease.offered_access_expires_at.getTime() - now.getTime()) / 1000),
    ),
    refreshExpiresIn: MAIL_LEASE_IDLE_SECONDS,
  };
}

async function revokeLease(tx: DbTransaction, lease: Lease, now: Date) {
  if (lease.revoked_at) return;
  await tx
    .update(mobileMailLeases)
    .set({
      revoked_at: now,
      initial_delivery: null,
      offered_refresh_hash: null,
      offered_access_hash: null,
      offered_access_expires_at: null,
      offered_delivery: null,
    })
    .where(eq(mobileMailLeases.id, lease.id));
}

async function findLeaseForRefresh(tx: DbTransaction, hash: string) {
  const [match] = await tx
    .select({ id: mobileMailLeases.id })
    .from(mobileMailLeases)
    .where(
      or(
        eq(mobileMailLeases.refresh_hash, hash),
        eq(mobileMailLeases.offered_refresh_hash, hash),
        exists(spentRefresh(tx, hash)),
      ),
    )
    .limit(1);
  return match ? await currentLease(tx, eq(mobileMailLeases.id, match.id)) : undefined;
}

export async function rotateMobileMailLease(refresh: string, now = new Date()): Promise<Rotation> {
  if (!MAIL_LEASE_REFRESH_PATTERN.test(refresh)) return { kind: "invalid" };
  const hash = mailLeaseTokenHash(refresh);
  return await dbWrite.transaction(async (tx) => {
    const row = await findLeaseForRefresh(tx, hash);
    if (!row) return { kind: "invalid" };
    let lease = row.lease;
    if (lease.refresh_hash !== hash && lease.offered_refresh_hash !== hash) {
      // The caller retires the entire device sign-in atomically. Its inactive
      // keys make this lease inadmissible through the same primary join.
      return { kind: "reused", principal: principal(row) };
    }
    if (!live(lease, now)) return { kind: "invalid" };

    let offeredRefresh: string | undefined;
    if (lease.offered_refresh_hash === hash) {
      lease = await keepOffer(tx, lease, now);
    } else if (lease.offered_delivery) {
      const offered = await revealOffer(lease, now);
      if (offered.accessExpiresIn > 0)
        return { kind: "offered", tokens: offered, principal: principal(row) };
      offeredRefresh = offered.refresh;
    }
    const tokens = {
      access: `eliza_lease_${randomBytes(32).toString("base64url")}`,
      refresh: offeredRefresh ?? newMailLeaseRefresh(),
    };
    const delivery = await encryptField(
      row.organizationId,
      JSON.stringify(tokens),
      offerDelivery(lease.id),
    );
    const checkedAt = new Date(Math.max(now.getTime(), Date.now()));
    if (!live(lease, checkedAt)) return { kind: "invalid" };
    await tx
      .update(mobileMailLeases)
      .set({
        offered_refresh_hash: mailLeaseTokenHash(tokens.refresh),
        offered_access_hash: mailLeaseTokenHash(tokens.access),
        offered_access_expires_at: new Date(checkedAt.getTime() + MAIL_LEASE_ACCESS_SECONDS * 1000),
        offered_delivery: delivery,
      })
      .where(eq(mobileMailLeases.id, lease.id));
    return {
      kind: "offered",
      principal: principal(row),
      tokens: {
        ...tokens,
        accessExpiresIn: MAIL_LEASE_ACCESS_SECONDS,
        refreshExpiresIn: MAIL_LEASE_IDLE_SECONDS,
      },
    };
  });
}

export async function endMobileMailLease(
  refresh: string,
  now = new Date(),
): Promise<MobileMailLeasePrincipal | null> {
  if (!MAIL_LEASE_REFRESH_PATTERN.test(refresh)) return null;
  const hash = mailLeaseTokenHash(refresh);
  return await dbWrite.transaction(async (tx) => {
    const row = await findLeaseForRefresh(tx, hash);
    if (!row) return null;
    const reused = row.lease.refresh_hash !== hash && row.lease.offered_refresh_hash !== hash;
    if (reused) return principal(row);
    await revokeLease(tx, row.lease, now);
    return null;
  });
}

type LeaseRenewal =
  | { kind: "admitted"; principal: MobileMailLeasePrincipal; renewableUntil: Date }
  | { kind: "reused"; principal: MobileMailLeasePrincipal }
  | { kind: "invalid" };

export async function admitMobileMailRenewal(refresh: string, now: Date): Promise<LeaseRenewal> {
  if (!MAIL_LEASE_REFRESH_PATTERN.test(refresh)) return { kind: "invalid" };
  const hash = mailLeaseTokenHash(refresh);
  return await dbWrite.transaction(async (tx) => {
    const row = await findLeaseForRefresh(tx, hash);
    if (!row) return { kind: "invalid" };
    const { lease } = row;
    if (lease.refresh_hash !== hash && lease.offered_refresh_hash !== hash) {
      return { kind: "reused", principal: principal(row) };
    }
    if (!live(lease, now)) return { kind: "invalid" };
    const current = lease.offered_refresh_hash === hash ? await keepOffer(tx, lease, now) : lease;
    return { kind: "admitted", principal: principal(row), renewableUntil: current.idle_expires_at };
  });
}

export async function mailLeaseAdmitsCredential(
  tx: DbTransaction,
  leaseId: string,
  sessionId: string,
  credentialId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: mobileMailLeases.id })
    .from(mobileMailLeases)
    .where(
      and(
        eq(mobileMailLeases.id, leaseId),
        eq(mobileMailLeases.session_id, sessionId),
        eq(mobileMailLeases.credential_id, credentialId),
        isNull(mobileMailLeases.initial_delivery),
        isNull(mobileMailLeases.revoked_at),
        gt(mobileMailLeases.idle_expires_at, now),
      ),
    )
    .limit(1)
    .for("update");
  return Boolean(row);
}
