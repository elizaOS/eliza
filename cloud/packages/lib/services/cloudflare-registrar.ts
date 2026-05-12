/**
 * Cloudflare Registrar Service
 *
 * Wraps Cloudflare's Registrar API (currently beta) for programmatic domain
 * search, availability + price check, registration, and registration-status
 * polling. Matches the per-CF-docs agent flow:
 *   1. Search   — fast keyword-to-candidates from cached data
 *   2. Check    — registry-direct availability + price (always run pre-buy)
 *   3. Register — start the registration; success debits the CF account
 *
 * Endpoints used (per developers.cloudflare.com/registrar/api):
 *   GET  /accounts/{id}/registrar/domain-search?q=<q>&limit=<n>
 *   POST /accounts/{id}/registrar/domain-check       body { domains: [...] }
 *   POST /accounts/{id}/registrar/registrations      body { domain_name }
 *   GET  /accounts/{id}/registrar/registrations/{domain}
 *   GET  /accounts/{id}/registrar/registrations/{domain}/registration-status
 *
 * This service is the at-cost wholesale layer. The user-facing margin lives
 * in `domain-pricing.ts` and is applied in the route layer, not here.
 *
 * Stub mode: when ELIZA_CF_REGISTRAR_DEV_STUB=1 the service returns
 * deterministic fake responses without ever calling cloudflare. Used for
 * local dev + integration tests that exercise credit-debit + DB writes
 * without spending money on real registrations.
 */

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { CloudflareApiError, cloudflareApiRequest } from "@/lib/utils/cloudflare-api";
import { logger } from "@/lib/utils/logger";

/** Read at call time so per-request Cloudflare Worker bindings are visible (cloud-bindings ALS). */
function config() {
  const env = getCloudAwareEnv();
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: env.CLOUDFLARE_API_TOKEN ?? "",
    devStub: env.ELIZA_CF_REGISTRAR_DEV_STUB === "1",
  };
}

export interface AvailabilityResult {
  domain: string;
  available: boolean;
  /** Wholesale price in USD cents (what cloudflare charges eliza cloud). */
  priceUsdCents: number;
  /** Currency code reported by cloudflare. Always "USD" today. */
  currency: string;
  /** Number of years the price covers (registry minimum, typically 1). */
  years: number;
  /** Renewal price in USD cents (often differs from initial registration). */
  renewalUsdCents?: number;
  /** Why the domain is not registrable, if so (e.g. "domain_unavailable"). */
  reason?: string;
}

export interface RegistrationStartResult {
  domain: string;
  registrationId: string;
  /** "pending" until cloudflare async-completes the registration. */
  status: "pending" | "active" | "failed" | "expired";
}

export interface RegistrationStatus {
  domain: string;
  status: "pending" | "active" | "failed" | "expired";
  completedAt: string | null;
  failureReason: string | null;
}

export interface RegisteredDomain {
  domain: string;
  zoneId: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
}

function ensureConfigured(c: { accountId: string; apiToken: string; devStub: boolean }): void {
  if (c.devStub) return;
  if (!c.accountId || !c.apiToken) {
    throw new Error(
      "Cloudflare Registrar is not configured: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or ELIZA_CF_REGISTRAR_DEV_STUB=1 for local dev.",
    );
  }
}

interface CfRegistrationResource {
  domain_name?: string;
  name?: string;
  status?: string | null;
  expires_at?: string | null;
  auto_renew?: boolean | null;
}

interface CfWorkflowStatus {
  domain_name?: string;
  name?: string;
  state?: string | null;
  status?: string | null;
  registration_status?: string | null;
  current_status?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
  failure_reason?: string | null;
  error?: { code?: string; message?: string } | null;
  context?: {
    domain_name?: string;
    registration?: CfRegistrationResource;
  } | null;
}

interface CfZone {
  id: string;
  name: string;
}

interface CfDeprecatedRegistrarDomain {
  id?: string | null;
  name?: string | null;
  zone_id?: string | null;
}

interface CfDomainCheckEntry {
  name: string;
  registrable: boolean;
  tier?: string;
  pricing?: { currency: string; registration_cost: string; renewal_cost: string };
  reason?: string;
}

function fromCheckEntry(entry: CfDomainCheckEntry): AvailabilityResult {
  const reg = entry.pricing ? Math.round(Number(entry.pricing.registration_cost) * 100) : 0;
  const renew = entry.pricing ? Math.round(Number(entry.pricing.renewal_cost) * 100) : undefined;
  return {
    domain: entry.name,
    available: entry.registrable,
    priceUsdCents: reg,
    renewalUsdCents: renew,
    currency: entry.pricing?.currency ?? "USD",
    years: 1,
    reason: entry.reason,
  };
}

/**
 * Check availability + real price of a single domain. CF docs recommend running
 * Check immediately before Register so the price you show the user matches what
 * they'll be charged.
 */
export async function checkAvailability(domain: string): Promise<AvailabilityResult> {
  const [first] = await checkAvailabilities([domain]);
  if (!first) {
    throw new CloudflareApiError(500, [
      { code: 0, message: `domain-check returned no entries for ${domain}` },
    ]);
  }
  return first;
}

/**
 * Batch availability check (CF accepts up to 20 domains per request). One CF
 * round-trip beats N parallel calls when comparing alternates ("check
 * mybrand.com, mybrand.io, mybrand.dev").
 */
export async function checkAvailabilities(domains: string[]): Promise<AvailabilityResult[]> {
  if (domains.length === 0) return [];
  if (domains.length > 20) {
    throw new Error("checkAvailabilities: cloudflare accepts at most 20 domains per call");
  }
  const cfg = config();
  ensureConfigured(cfg);

  if (cfg.devStub) {
    return domains.map(stubAvailability);
  }

  const result = await cloudflareApiRequest<{ domains: CfDomainCheckEntry[] }>(
    `/accounts/${cfg.accountId}/registrar/domain-check`,
    cfg.apiToken,
    {
      method: "POST",
      body: JSON.stringify({ domains }),
    },
  );
  return (result.domains ?? []).map(fromCheckEntry);
}

/**
 * Keyword search returning candidate domains with prices. Backed by CF's
 * cached search index — fast, but not a source of truth for availability.
 * Always run `checkAvailability` on the chosen candidate before registering.
 */
export async function searchDomains(query: string, limit = 10): Promise<AvailabilityResult[]> {
  const cfg = config();
  ensureConfigured(cfg);

  if (cfg.devStub) {
    logger.info("[Cloudflare Registrar:STUB] search", { query, limit });
    return [
      { ...stubAvailability(`${query}.com`), priceUsdCents: 1099 },
      { ...stubAvailability(`${query}.io`), priceUsdCents: 3500 },
      { ...stubAvailability(`${query}.dev`), priceUsdCents: 1500 },
    ].slice(0, limit);
  }

  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const result = await cloudflareApiRequest<{ domains: CfDomainCheckEntry[] }>(
    `/accounts/${cfg.accountId}/registrar/domain-search?q=${encodeURIComponent(query)}&limit=${boundedLimit}`,
    cfg.apiToken,
  );
  return (result.domains ?? []).map(fromCheckEntry);
}

/**
 * Start the registration of a domain. CF charges the account's default payment
 * method; defaults to no auto-renew + WHOIS redaction (per CF defaults).
 */
export async function registerDomain(domain: string): Promise<RegistrationStartResult> {
  const cfg = config();
  ensureConfigured(cfg);

  if (cfg.devStub) {
    return stubRegister(domain);
  }

  const result = await cloudflareApiRequest<CfWorkflowStatus>(
    `/accounts/${cfg.accountId}/registrar/registrations`,
    cfg.apiToken,
    {
      method: "POST",
      body: JSON.stringify({ domain_name: domain }),
    },
  );

  const registration = result.context?.registration;
  const domainName =
    result.domain_name ??
    registration?.domain_name ??
    result.context?.domain_name ??
    result.name ??
    domain;

  return {
    domain: domainName,
    registrationId: domainName,
    status: normalizeWorkflowStatus(result),
  };
}

export async function getRegistrationStatus(domain: string): Promise<RegistrationStatus> {
  const cfg = config();
  ensureConfigured(cfg);

  if (cfg.devStub) {
    return stubStatus(domain);
  }

  const result = await cloudflareApiRequest<CfWorkflowStatus>(
    `/accounts/${cfg.accountId}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`,
    cfg.apiToken,
  );

  let status = normalizeWorkflowStatus(result);

  if (!workflowStatusCandidate(result)) {
    logger.warn("[Cloudflare Registrar] registration-status response missing status field", {
      domain,
    });
    try {
      const registered = await getRegisteredDomain(domain);
      if (registered.zoneId) status = "active";
    } catch (err) {
      logger.warn("[Cloudflare Registrar] registered-domain fallback failed", {
        domain,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    domain: result.domain_name ?? result.context?.registration?.domain_name ?? domain,
    status,
    completedAt: result.completed_at ?? result.updated_at ?? null,
    failureReason: result.error?.message ?? result.failure_reason ?? null,
  };
}

/**
 * Fetch an already-registered domain's metadata. After a successful
 * registration, the domain has a cloudflare-managed zone whose id we need to
 * write DNS records into via `cloudflare-dns.ts`.
 */
export async function getRegisteredDomain(domain: string): Promise<RegisteredDomain> {
  const cfg = config();
  ensureConfigured(cfg);

  if (cfg.devStub) {
    return stubGetDomain(domain);
  }

  const result = await cloudflareApiRequest<CfRegistrationResource>(
    `/accounts/${cfg.accountId}/registrar/registrations/${encodeURIComponent(domain)}`,
    cfg.apiToken,
  );

  const domainName = result.domain_name ?? result.name ?? domain;
  const zoneId = await getZoneIdForDomain(cfg, domainName);

  return {
    domain: domainName,
    zoneId,
    expiresAt: result.expires_at ?? null,
    autoRenew: result.auto_renew ?? false,
  };
}

function workflowStatusCandidate(result: CfWorkflowStatus): unknown {
  return (
    result.context?.registration?.status ??
    result.status ??
    result.registration_status ??
    result.state ??
    result.current_status ??
    null
  );
}

function normalizeWorkflowStatus(
  result: CfWorkflowStatus,
): "pending" | "active" | "failed" | "expired" {
  return normalizeRegistrationStatus(workflowStatusCandidate(result));
}

export function normalizeRegistrationStatus(
  raw: unknown,
): "pending" | "active" | "failed" | "expired" {
  if (typeof raw !== "string") return "pending";
  const v = raw.trim().toLowerCase();
  if (v === "active" || v === "registered" || v === "succeeded" || v === "complete")
    return "active";
  if (v === "failed" || v === "cancelled" || v === "rejected") return "failed";
  if (v === "expired" || v === "redemption_period" || v === "pending_delete") return "expired";
  return "pending";
}

async function getZoneIdForDomain(
  cfg: { accountId: string; apiToken: string },
  domain: string,
): Promise<string | null> {
  const normalized = domain.toLowerCase().replace(/\.$/, "");

  try {
    const zones = await cloudflareApiRequest<CfZone[]>(
      `/zones?name=${encodeURIComponent(normalized)}&account.id=${encodeURIComponent(
        cfg.accountId,
      )}&per_page=1`,
      cfg.apiToken,
    );
    const zone = zones.find((candidate) => candidate.name.toLowerCase() === normalized) ?? zones[0];
    if (zone?.id) return zone.id;
  } catch (error) {
    logger.warn("[Cloudflare Registrar] zone lookup failed", {
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const legacy = await cloudflareApiRequest<CfDeprecatedRegistrarDomain>(
      `/accounts/${cfg.accountId}/registrar/domains/${encodeURIComponent(normalized)}`,
      cfg.apiToken,
    );
    return legacy.zone_id ?? legacy.id ?? null;
  } catch (error) {
    logger.warn("[Cloudflare Registrar] deprecated registrar-domain lookup failed", {
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// dev stub responses (only fire when ELIZA_CF_REGISTRAR_DEV_STUB=1)
// ─────────────────────────────────────────────────────────────────────────

function stubAvailability(domain: string): AvailabilityResult {
  logger.info("[Cloudflare Registrar:STUB] availability", { domain });
  const taken = domain.startsWith("taken-");
  return {
    domain,
    available: !taken,
    priceUsdCents: 1099,
    renewalUsdCents: 1099,
    currency: "USD",
    years: 1,
  };
}

function stubRegister(domain: string): RegistrationStartResult {
  logger.info("[Cloudflare Registrar:STUB] register", { domain });
  if (domain.startsWith("fail-")) {
    throw new CloudflareApiError(400, [
      { code: 1300, message: "stub: simulated registration failure" },
    ]);
  }
  return {
    domain,
    registrationId: `stub-reg-${domain}`,
    status: "pending",
  };
}

function stubStatus(domain: string): RegistrationStatus {
  return {
    domain,
    status: "active",
    completedAt: new Date().toISOString(),
    failureReason: null,
  };
}

function stubGetDomain(domain: string): RegisteredDomain {
  return {
    domain,
    zoneId: `stub-zone-${domain}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    autoRenew: true,
  };
}

export const cloudflareRegistrarService = {
  checkAvailability,
  checkAvailabilities,
  searchDomains,
  registerDomain,
  getRegistrationStatus,
  getRegisteredDomain,
};
