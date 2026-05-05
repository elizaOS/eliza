import type { ManagedDomain } from "@/db/schemas/managed-domains";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { managedDomainsService } from "@/lib/services/managed-domains";
import type { AppContext } from "@/types/cloud-worker-env";

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"] as const;

type DnsContextError = {
  error: string;
  status: 400 | 403 | 404 | 409;
};

type DnsDomainContext = {
  appId: string;
  domain: ManagedDomain;
  zoneId: string;
};

type DnsRecordContext = DnsDomainContext & {
  recordId: string;
};

export async function loadCloudflareManagedDomain(
  c: AppContext,
): Promise<DnsDomainContext | DnsContextError> {
  const user = await requireUserOrApiKeyWithOrg(c);
  const appId = c.req.param("id");
  const domainParam = c.req.param("domain");
  if (!appId || !domainParam) return { error: "missing path params", status: 400 as const };

  const appRow = await appsService.getById(appId);
  if (!appRow) {
    return { error: "App not found", status: 404 as const };
  }
  if (appRow.organization_id !== user.organization_id) {
    return { error: "App belongs to a different organization", status: 403 as const };
  }

  const domain = await managedDomainsService.getDomainByName(decodeURIComponent(domainParam));
  if (!domain || domain.organizationId !== user.organization_id || domain.appId !== appId) {
    return { error: "Domain not attached to this app", status: 404 as const };
  }
  if (domain.registrar !== "cloudflare" || !domain.cloudflareZoneId) {
    return {
      error: "DNS records on external domains must be edited at your existing DNS provider",
      status: 409 as const,
    };
  }

  return { appId, domain, zoneId: domain.cloudflareZoneId };
}

export async function loadCloudflareManagedDomainRecord(
  c: AppContext,
): Promise<DnsRecordContext | DnsContextError> {
  const ctx = await loadCloudflareManagedDomain(c);
  if ("error" in ctx) return ctx;

  const recordId = c.req.param("recordId");
  if (!recordId) return { error: "missing path params", status: 400 as const };

  return { ...ctx, recordId };
}
