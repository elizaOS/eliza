// Coordinates the one-off backfill of per-org Steward tenants (#14645).
//
// Steward tenants were historically provisioned LAZILY — only at first
// agent-provision (docker-sandbox-provider -> ensureStewardTenant). PR #14869
// makes them eager at signup, but every org that signed up BEFORE that fix
// still has `steward_tenant_id = NULL` and therefore hits the
// `GET /steward/user/me/tenants` 403 -> infinite /login bounce. This backfill
// provisions a tenant for each such org so those existing users stop looping.
//
// Safe by construction: `ensureStewardTenant` is idempotent + 409-tolerant and
// short-circuits for orgs that already hold a tenant, so re-running is a no-op
// for the populated majority. Mirrors the (now-retired) steward-user backfill —
// users went through the same lazy -> eager-mandatory-at-signup + backfill path.

import { isNull } from "drizzle-orm";
import { readQuery } from "../../db/helpers";
import { organizations } from "../../db/schemas/organizations";
import { logger } from "../utils/logger";
import { ensureStewardTenant } from "./steward-tenant-config";

export interface StewardTenantBackfillOptions {
  /** Orgs to provision per concurrent batch (default: 25). */
  batchSize?: number;
  /** Stop after processing at most this many candidate orgs. */
  maxOrgs?: number;
  /** List candidates without provisioning. */
  dryRun?: boolean;
}

export interface StewardTenantBackfillSummary {
  scanned: number;
  provisioned: number;
  failed: number;
  dryRun: boolean;
}

export async function backfillStewardTenants(
  options: StewardTenantBackfillOptions = {},
): Promise<StewardTenantBackfillSummary> {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 25;

  const candidates = await readQuery(
    async (db) =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(isNull(organizations.steward_tenant_id)),
    "backfillStewardTenants.listNullTenantOrgs",
  );

  const limited =
    options.maxOrgs && options.maxOrgs > 0 ? candidates.slice(0, options.maxOrgs) : candidates;

  const summary: StewardTenantBackfillSummary = {
    scanned: limited.length,
    provisioned: 0,
    failed: 0,
    dryRun,
  };

  logger.info(
    `[StewardTenantMigration] Backfill starting: ${limited.length} org(s) with NULL steward_tenant_id${dryRun ? " (dry-run)" : ""}`,
  );

  if (dryRun) {
    for (const org of limited) {
      logger.info(`[StewardTenantMigration] (dry-run) would provision tenant for org ${org.id}`);
    }
    return summary;
  }

  for (let i = 0; i < limited.length; i += batchSize) {
    const batch = limited.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((org) => ensureStewardTenant(org.id)));
    results.forEach((result, index) => {
      const orgId = batch[index].id;
      if (result.status === "fulfilled") {
        summary.provisioned += 1;
        logger.info(
          `[StewardTenantMigration] Provisioned tenant ${result.value.tenantId} for org ${orgId} (isNew=${result.value.isNew})`,
        );
      } else {
        summary.failed += 1;
        const cause =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.error(
          `[StewardTenantMigration] Failed to provision tenant for org ${orgId}: ${cause}`,
        );
      }
    });
  }

  logger.info(
    `[StewardTenantMigration] Backfill complete: scanned=${summary.scanned} provisioned=${summary.provisioned} failed=${summary.failed}`,
  );

  return summary;
}
