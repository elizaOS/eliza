/**
 * App Domains Compat
 *
 * Bridges the legacy `app_domains` table (one-row-per-app, used by the
 * existing dashboard UI) with the new `managed_domains` table (many-rows-
 * per-app, used by the registrar broker + agent skills).
 *
 * Whenever the broker mutates a domain attached to an app, call the matching
 * helper here to keep the legacy `app_domains.custom_domain` field in sync —
 * that's what the existing AppDomains React component reads, so the UI keeps
 * showing the right URL without any frontend change.
 *
 * The legacy row's `subdomain` is owned by the app-deploy flow, NOT by us;
 * we only touch the custom_domain / verified / ssl_status fields.
 */

import { and, eq } from "drizzle-orm";
import { dbWrite } from "@/db/client";
import { appDomains } from "@/db/schemas/app-domains";
import { logger } from "@/lib/utils/logger";

export interface SyncCustomDomainInput {
  appId: string;
  domain: string;
  verified: boolean;
}

/** Set the app's custom_domain after a successful buy or external attach. */
export async function setCustomDomain(input: SyncCustomDomainInput): Promise<void> {
  try {
    await dbWrite
      .update(appDomains)
      .set({
        custom_domain: input.domain,
        custom_domain_verified: input.verified,
        ssl_status: input.verified ? "active" : "pending",
        verified_at: input.verified ? new Date() : null,
        updated_at: new Date(),
      })
      .where(and(eq(appDomains.app_id, input.appId), eq(appDomains.is_primary, true)));
  } catch (error) {
    logger.warn("[AppDomainsCompat] setCustomDomain skipped (legacy row missing?)", {
      appId: input.appId,
      domain: input.domain,
      error,
    });
  }
}

/** Clear the app's custom_domain on detach. */
export async function clearCustomDomain(appId: string): Promise<void> {
  try {
    await dbWrite
      .update(appDomains)
      .set({
        custom_domain: null,
        custom_domain_verified: false,
        ssl_status: "pending",
        verified_at: null,
        updated_at: new Date(),
      })
      .where(and(eq(appDomains.app_id, appId), eq(appDomains.is_primary, true)));
  } catch (error) {
    logger.warn("[AppDomainsCompat] clearCustomDomain skipped", { appId, error });
  }
}

export const appDomainsCompat = {
  setCustomDomain,
  clearCustomDomain,
};
