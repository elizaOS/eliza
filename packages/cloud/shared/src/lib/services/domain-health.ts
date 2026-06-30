/**
 * Custom-domain health verification (#10244, last-mile of the domain-buy path).
 *
 * A bought domain becomes `active` + `verified` once its Cloudflare zone is
 * provisioned and CNAME'd at the app's origin, but that does not prove the app
 * actually serves over the custom hostname. This probe fetches `https://<domain>/health`
 * through the SSRF guard and flips `is_live` (and records the last error) so the
 * dashboard can show "serving" vs "registered but not yet reachable". Driven by
 * the `cron/domain-health` route.
 */

import type { ManagedDomain } from "../../db/schemas/managed-domains";
import { safeFetch } from "../security/safe-fetch";
import { logger } from "../utils/logger";
import { managedDomainsService } from "./managed-domains";

/** Domains probed per cron tick. */
export const DOMAIN_HEALTH_BATCH = 25;
const PROBE_TIMEOUT_MS = 8000;

export interface DomainHealthResult {
  domain: string;
  live: boolean;
  status?: number;
  error?: string;
}

export interface DomainHealthRunSummary {
  ranAt: string;
  checked: number;
  live: number;
  results: DomainHealthResult[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function probeDomain(domain: ManagedDomain): Promise<DomainHealthResult> {
  const url = `https://${domain.domain}/health`;
  try {
    const res = await safeFetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const live = res.status >= 200 && res.status < 300;
    await managedDomainsService.syncStatus({
      domainId: domain.id,
      isLive: live,
      healthCheckError: live ? null : `health probe returned ${res.status}`,
    });
    return live
      ? { domain: domain.domain, live: true, status: res.status }
      : {
          domain: domain.domain,
          live: false,
          status: res.status,
          error: `status ${res.status}`,
        };
  } catch (err) {
    const error = errorMessage(err);
    await managedDomainsService.syncStatus({
      domainId: domain.id,
      isLive: false,
      healthCheckError: error,
    });
    return { domain: domain.domain, live: false, error };
  }
}

export async function probeDomainHealth(
  now: Date = new Date(),
  limit: number = DOMAIN_HEALTH_BATCH,
): Promise<DomainHealthRunSummary> {
  const domains = await managedDomainsService.listCloudflareNeedingHealthCheck(limit);
  const results: DomainHealthResult[] = [];
  for (const domain of domains) {
    results.push(await probeDomain(domain));
  }
  const live = results.filter((r) => r.live).length;
  if (domains.length > 0) {
    logger.info("[Domain Health] probed custom domains", {
      checked: domains.length,
      live,
    });
  }
  return { ranAt: now.toISOString(), checked: domains.length, live, results };
}

export const domainHealthService = { probeDomain, probeDomainHealth };
