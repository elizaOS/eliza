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

import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
  type DomainRegistrantInfo,
  type ManagedDomain,
  managedDomains,
  type NewManagedDomain,
} from "@/db/schemas/managed-domains";
import { logger } from "@/lib/utils/logger";

export interface InsertCloudflareDomainInput {
  organizationId: string;
  domain: string;
  cloudflareZoneId: string;
  cloudflareRegistrationId: string;
  purchasePriceCents: number;
  renewalPriceCents: number;
  expiresAt: Date | null;
  registrantInfo: DomainRegistrantInfo | null;
}

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
 * Insert a freshly-registered cloudflare domain. Sets registrar='cloudflare',
 * nameserver_mode='cloudflare' (cloudflare manages our DNS too), and
 * status='active' since cloudflare register-status was already polled to
 * active before this call.
 */
export async function insertCloudflareRegisteredDomain(
  input: InsertCloudflareDomainInput,
): Promise<ManagedDomain> {
  const row: NewManagedDomain = {
    organizationId: input.organizationId,
    domain: input.domain.toLowerCase().trim(),
    registrar: "cloudflare",
    nameserverMode: "cloudflare",
    status: "active",
    registeredAt: new Date(),
    expiresAt: input.expiresAt,
    autoRenew: true,
    cloudflareZoneId: input.cloudflareZoneId,
    cloudflareRegistrationId: input.cloudflareRegistrationId,
    registrantInfo: input.registrantInfo,
    purchasePrice: String(input.purchasePriceCents),
    renewalPrice: String(input.renewalPriceCents),
    paymentMethod: "credits",
    verified: true,
    verifiedAt: new Date(),
  };

  const [created] = await dbWrite.insert(managedDomains).values(row).returning();
  if (!created) {
    throw new Error("managed_domains insert returned no rows");
  }
  logger.info("[Managed Domains] inserted cloudflare-registered domain", {
    domainId: created.id,
    domain: created.domain,
    zoneId: created.cloudflareZoneId,
  });
  return created;
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
  const existing = await getDomainByName(normalized);
  if (existing && existing.organizationId !== input.organizationId) {
    throw new Error("managed domain belongs to a different organization");
  }

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

export async function getDomainByName(domain: string): Promise<ManagedDomain | null> {
  const normalized = domain.toLowerCase().trim();
  const row = await dbRead.query.managedDomains.findFirst({
    where: eq(managedDomains.domain, normalized),
  });
  return row ?? null;
}

export async function listForOrganization(organizationId: string): Promise<ManagedDomain[]> {
  return await dbRead.query.managedDomains.findMany({
    where: eq(managedDomains.organizationId, organizationId),
  });
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
  insertCloudflareRegisteredDomain,
  upsertCloudflareRegisteredDomain,
  insertExternalDomain,
  assignToResource,
  unassignFromResource,
  syncStatus,
  getDomainById,
  getDomainByName,
  listForOrganization,
  listForApp,
  listVerifiedAppOrigins,
};
