/**
 * Managed Domains Service
 *
 * Write/read facade over the `managed_domains` table. Encapsulates the
 * polymorphic resource-assignment logic (an app vs container vs agent vs
 * mcp pointer in the same row) and the cloudflare-registrar persistence
 * shape so route layers don't reach into drizzle directly for these
 * operations.
 *
 * Reads/writes that aren't shared across multiple call sites should NOT
 * be added here — keep this thin enough that every method is doing real
 * work, not wrapping a one-line insert.
 */

import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/client";
import {
  type DomainRegistrantInfo,
  type ManagedDomain,
  managedDomains,
  type NewManagedDomain,
} from "../../db/schemas/managed-domains";
import { logger } from "../utils/logger";

export interface UpsertCloudflareDomainInput {
  organizationId: string;
  domain: string;
  cloudflareZoneId?: string | null;
  cloudflareRegistrationId?: string | null;
  purchasePriceCents?: number | null;
  renewalPriceCents?: number | null;
  expiresAt?: Date | null;
  registrantInfo?: DomainRegistrantInfo | null;
  status?: ManagedDomain["status"];
  verified?: boolean;
  autoRenew?: boolean;
}

/**
 * Create or repair a cloudflare-registered domain row. This is intentionally
 * idempotent for registrar flows where Cloudflare successfully charges/registers
 * the domain but async zone provisioning or a local API crash happens before
 * the row is persisted.
 */
export async function upsertCloudflareRegisteredDomain(
  input: UpsertCloudflareDomainInput,
): Promise<ManagedDomain> {
  const normalized = input.domain.toLowerCase().trim();
  // Block if ANOTHER org already holds the exclusive slot; otherwise operate on
  // THIS org's own row (which may be an unverified external pending row that
  // getDomainByName intentionally hides — we upgrade it to cloudflare here).
  const exclusive = await getDomainByName(normalized);
  if (exclusive && exclusive.organizationId !== input.organizationId) {
    throw new Error("managed domain belongs to a different organization");
  }
  const existing = await getOwnDomainRow(input.organizationId, normalized);

  const now = new Date();
  const status = input.status ?? (input.cloudflareZoneId ? "active" : "pending");
  const verified = input.verified ?? status === "active";
  const base: Partial<NewManagedDomain> = {
    registrar: "cloudflare",
    nameserverMode: "cloudflare",
    status,
    registeredAt: existing?.registeredAt ?? now,
    autoRenew: input.autoRenew ?? existing?.autoRenew ?? false,
    cloudflareZoneId: input.cloudflareZoneId ?? existing?.cloudflareZoneId ?? null,
    cloudflareRegistrationId:
      input.cloudflareRegistrationId ?? existing?.cloudflareRegistrationId ?? null,
    registrantInfo: input.registrantInfo ?? existing?.registrantInfo ?? null,
    paymentMethod: "credits",
    verified,
    verificationToken: null,
    healthCheckError: null,
    updatedAt: now,
  };
  if (input.expiresAt !== undefined) base.expiresAt = input.expiresAt;
  if (input.purchasePriceCents !== undefined && input.purchasePriceCents !== null) {
    base.purchasePrice = String(input.purchasePriceCents);
  }
  if (input.renewalPriceCents !== undefined && input.renewalPriceCents !== null) {
    base.renewalPrice = String(input.renewalPriceCents);
  }
  if (verified && !existing?.verified) base.verifiedAt = now;

  if (existing) {
    const [updated] = await dbWrite
      .update(managedDomains)
      .set(base)
      .where(eq(managedDomains.id, existing.id))
      .returning();
    if (!updated) {
      throw new Error(`managed_domains update returned no rows for id ${existing.id}`);
    }
    logger.info("[Managed Domains] upserted cloudflare-registered domain", {
      domainId: updated.id,
      domain: updated.domain,
      zoneId: updated.cloudflareZoneId,
      status: updated.status,
    });
    return updated;
  }

  const row: NewManagedDomain = {
    organizationId: input.organizationId,
    domain: normalized,
    ...base,
  };
  const [created] = await dbWrite.insert(managedDomains).values(row).returning();
  if (!created) {
    throw new Error("managed_domains insert returned no rows");
  }
  logger.info("[Managed Domains] inserted cloudflare-registered domain", {
    domainId: created.id,
    domain: created.domain,
    zoneId: created.cloudflareZoneId,
    status: created.status,
  });
  return created;
}

export type ResourceAssignment =
  | { type: "app"; id: string }
  | { type: "container"; id: string }
  | { type: "agent"; id: string }
  | { type: "mcp"; id: string };

/**
 * Assign a managed domain to one app/container/agent/mcp resource. The
 * managed_domains schema stores all four FKs polymorphically with a
 * resource_type discriminator; only the matching FK is set.
 */
export async function assignToResource(
  domainId: string,
  target: ResourceAssignment,
): Promise<ManagedDomain> {
  const update: Partial<NewManagedDomain> = {
    resourceType: target.type,
    appId: target.type === "app" ? target.id : null,
    containerId: target.type === "container" ? target.id : null,
    agentId: target.type === "agent" ? target.id : null,
    mcpId: target.type === "mcp" ? target.id : null,
    updatedAt: new Date(),
  };

  const [updated] = await dbWrite
    .update(managedDomains)
    .set(update)
    .where(eq(managedDomains.id, domainId))
    .returning();
  if (!updated) {
    throw new Error(`managed_domains update returned no rows for id ${domainId}`);
  }
  return updated;
}

export async function getDomainById(domainId: string): Promise<ManagedDomain | null> {
  const row = await dbRead.query.managedDomains.findFirst({
    where: eq(managedDomains.id, domainId),
  });
  return row ?? null;
}

/**
 * The globally EXCLUSIVE row for a domain: a verified row, or a cloudflare
 * registrar row. At most one exists (enforced by the partial unique index).
 * Returns null when only unverified external pending rows exist — those never
 * own the domain globally, so an unverified squat can't be mistaken for the
 * rightful owner (#11024). Serving/resolution callers want exactly this: they
 * already gate on `verified && status==='active'`, and must never resolve a host
 * to another org's unproven pending row.
 */
export async function getDomainByName(domain: string): Promise<ManagedDomain | null> {
  const normalized = domain.toLowerCase().trim();
  const row = await dbRead.query.managedDomains.findFirst({
    where: and(
      eq(managedDomains.domain, normalized),
      or(eq(managedDomains.verified, true), eq(managedDomains.registrar, "cloudflare")),
    ),
  });
  return row ?? null;
}

/**
 * The caller org's OWN row for a domain (verified or not). App-management routes
 * (attach/verify/dns/status/rename/buy) operate on the caller's own pending row,
 * which `getDomainByName` intentionally hides while it is unverified. Scoped to
 * `(organization_id, domain)`, which is unique — so at most one row.
 */
export async function getOwnDomainRow(
  organizationId: string,
  domain: string,
): Promise<ManagedDomain | null> {
  const normalized = domain.toLowerCase().trim();
  const row = await dbRead.query.managedDomains.findFirst({
    where: and(
      eq(managedDomains.domain, normalized),
      eq(managedDomains.organizationId, organizationId),
    ),
  });
  return row ?? null;
}

/**
 * Delete external rows that are still unverified after `olderThanMs` — the
 * reclaim path that stops an unproven attach from squatting a domain forever.
 * Returns the number of rows released. Intended for a periodic cron.
 */
export async function releaseStaleUnverifiedExternals(olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const deleted = await dbWrite
    .delete(managedDomains)
    .where(
      and(
        eq(managedDomains.verified, false),
        eq(managedDomains.registrar, "external"),
        lte(managedDomains.createdAt, cutoff),
      ),
    )
    .returning({ id: managedDomains.id });
  return deleted.length;
}

export async function listForOrganization(organizationId: string): Promise<ManagedDomain[]> {
  return await dbRead.query.managedDomains.findMany({
    where: eq(managedDomains.organizationId, organizationId),
  });
}

export async function countForOrganization(organizationId: string): Promise<number> {
  const [row] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(managedDomains)
    .where(eq(managedDomains.organizationId, organizationId));
  return row?.count ?? 0;
}

export async function listForApp(organizationId: string, appId: string): Promise<ManagedDomain[]> {
  return await dbRead.query.managedDomains.findMany({
    where: and(eq(managedDomains.organizationId, organizationId), eq(managedDomains.appId, appId)),
  });
}

export async function listVerifiedAppOrigins(appId: string): Promise<string[]> {
  const rows = await dbRead
    .select({ domain: managedDomains.domain })
    .from(managedDomains)
    .where(
      and(
        eq(managedDomains.appId, appId),
        eq(managedDomains.status, "active"),
        eq(managedDomains.verified, true),
      ),
    );
  return rows.map((row) => `https://${row.domain.toLowerCase().trim()}`);
}

/**
 * Cloudflare-registered domains whose registry expiry falls within `windowDays`
 * and that are still set to auto-renew. The renewal cron debits the org and
 * keeps the registration alive for each of these (idempotent per period).
 */
export async function listCloudflareRenewalsDue(
  now: Date,
  windowDays: number,
): Promise<ManagedDomain[]> {
  const cutoff = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
  return await dbRead.query.managedDomains.findMany({
    where: and(
      eq(managedDomains.registrar, "cloudflare"),
      eq(managedDomains.status, "active"),
      eq(managedDomains.autoRenew, true),
      isNotNull(managedDomains.expiresAt),
      lte(managedDomains.expiresAt, cutoff),
    ),
  });
}

/**
 * Cloudflare-registered, active, verified domains that are not yet confirmed
 * live. The health-check cron probes each domain's origin and flips `isLive`.
 */
export async function listCloudflareNeedingHealthCheck(limit: number): Promise<ManagedDomain[]> {
  return await dbRead.query.managedDomains.findMany({
    where: and(
      eq(managedDomains.registrar, "cloudflare"),
      eq(managedDomains.status, "active"),
      eq(managedDomains.verified, true),
      eq(managedDomains.isLive, false),
    ),
    limit,
  });
}

/**
 * Advance a domain's registry expiry after a successful renewal and keep it
 * active. Mirrors syncStatus' updatedAt bump.
 */
export async function recordRenewal(domainId: string, newExpiresAt: Date): Promise<ManagedDomain> {
  const [updated] = await dbWrite
    .update(managedDomains)
    .set({ expiresAt: newExpiresAt, status: "active", updatedAt: new Date() })
    .where(eq(managedDomains.id, domainId))
    .returning();
  if (!updated) throw new Error(`managed_domains update returned no rows for id ${domainId}`);
  return updated;
}

/**
 * Toggle a domain's auto-renew flag (lapse policy: a declined renewal debit
 * disables auto-renew so Cloudflare stops renewing it on our account).
 */
export async function setAutoRenew(domainId: string, autoRenew: boolean): Promise<ManagedDomain> {
  const [updated] = await dbWrite
    .update(managedDomains)
    .set({ autoRenew, updatedAt: new Date() })
    .where(eq(managedDomains.id, domainId))
    .returning();
  if (!updated) throw new Error(`managed_domains update returned no rows for id ${domainId}`);
  return updated;
}

export interface InsertExternalDomainInput {
  organizationId: string;
  domain: string;
  verificationToken: string;
}

/**
 * Insert a domain the user already owns elsewhere. Sets registrar='external',
 * status='pending', verified=false. Caller is responsible for showing the
 * user the verification record they need to add to their existing DNS.
 */
export async function insertExternalDomain(
  input: InsertExternalDomainInput,
): Promise<ManagedDomain> {
  const row: NewManagedDomain = {
    organizationId: input.organizationId,
    domain: input.domain.toLowerCase().trim(),
    registrar: "external",
    nameserverMode: "external",
    status: "pending",
    autoRenew: false,
    verified: false,
    verificationToken: input.verificationToken,
  };
  const [created] = await dbWrite.insert(managedDomains).values(row).returning();
  if (!created) throw new Error("managed_domains insert returned no rows");
  logger.info("[Managed Domains] inserted external domain", {
    domainId: created.id,
    domain: created.domain,
  });
  return created;
}

export interface SyncStatusInput {
  domainId: string;
  status?: ManagedDomain["status"];
  verified?: boolean;
  sslStatus?: ManagedDomain["sslStatus"];
  isLive?: boolean;
  healthCheckError?: string | null;
}

/**
 * Persist live registrar status back to the managed_domains row. Called by
 * /sync and /verify after fetching upstream status. Always bumps
 * lastHealthCheck and updatedAt. verified_at is set the FIRST time
 * verified flips to true.
 */
export async function syncStatus(input: SyncStatusInput): Promise<ManagedDomain> {
  const existing = await getDomainById(input.domainId);
  if (!existing) throw new Error(`managed_domain ${input.domainId} not found`);

  const update: Partial<NewManagedDomain> = {
    lastHealthCheck: new Date(),
    updatedAt: new Date(),
  };
  if (input.status !== undefined) update.status = input.status;
  if (input.verified !== undefined) {
    update.verified = input.verified;
    if (input.verified && !existing.verified) update.verifiedAt = new Date();
  }
  if (input.sslStatus !== undefined) update.sslStatus = input.sslStatus;
  if (input.isLive !== undefined) update.isLive = input.isLive;
  if (input.healthCheckError !== undefined) update.healthCheckError = input.healthCheckError;

  const [updated] = await dbWrite
    .update(managedDomains)
    .set(update)
    .where(eq(managedDomains.id, input.domainId))
    .returning();
  if (!updated) throw new Error(`managed_domains update returned no rows for id ${input.domainId}`);
  return updated;
}

/**
 * Detach a domain from any resource without deleting the row. The
 * registration itself stays active until expiration.
 */
export async function unassignFromResource(domainId: string): Promise<ManagedDomain> {
  const [updated] = await dbWrite
    .update(managedDomains)
    .set({
      resourceType: null,
      appId: null,
      containerId: null,
      agentId: null,
      mcpId: null,
      updatedAt: new Date(),
    })
    .where(eq(managedDomains.id, domainId))
    .returning();
  if (!updated) throw new Error(`managed_domains update returned no rows for id ${domainId}`);
  return updated;
}

export const managedDomainsService = {
  upsertCloudflareRegisteredDomain,
  insertExternalDomain,
  assignToResource,
  unassignFromResource,
  syncStatus,
  getDomainById,
  getDomainByName,
  getOwnDomainRow,
  releaseStaleUnverifiedExternals,
  listForOrganization,
  countForOrganization,
  listForApp,
  listVerifiedAppOrigins,
  listCloudflareRenewalsDue,
  listCloudflareNeedingHealthCheck,
  recordRenewal,
  setAutoRenew,
};
