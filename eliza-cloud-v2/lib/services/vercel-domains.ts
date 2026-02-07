/**
 * Vercel Domains Service
 *
 * Manages custom domains for apps through Vercel's API.
 * Each app has its own Vercel project, so domain operations
 * use the app's specific project ID.
 *
 * Supports:
 * - Adding custom domains programmatically
 * - Domain ownership verification
 * - DNS status checking with real SSL verification
 * - Domain removal
 * - Conflict detection
 * - Reserved subdomain protection
 */

import { dbRead, dbWrite } from "@/db/client";
import {
  appDomains,
  type DomainVerificationRecord,
} from "@/db/schemas/app-domains";
import { eq, and, ne } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { vercelApiRequest } from "@/lib/utils/vercel-api";

// Vercel API configuration
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const APP_DOMAIN = process.env.APP_DOMAIN || "apps.elizacloud.ai";

// Reserved subdomains that cannot be used for apps
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "dashboard",
  "app",
  "apps",
  "auth",
  "login",
  "signup",
  "register",
  "account",
  "settings",
  "billing",
  "docs",
  "help",
  "support",
  "status",
  "cdn",
  "static",
  "assets",
  "media",
  "images",
  "files",
  "mail",
  "email",
  "smtp",
  "ftp",
  "ssh",
  "git",
  "svn",
  "blog",
  "news",
  "forum",
  "community",
  "store",
  "shop",
  "cart",
  "checkout",
  "pay",
  "payments",
  "webhook",
  "webhooks",
  "ws",
  "wss",
  "socket",
  "graphql",
  "rest",
  "v1",
  "v2",
  "v3",
  "staging",
  "dev",
  "test",
  "demo",
  "preview",
  "beta",
  "alpha",
  "internal",
  "private",
  "public",
  "sandbox",
  "debug",
]);

// Vercel API response types
interface VercelDomainVerification {
  type: string;
  domain: string;
  value: string;
  reason: string;
}

interface VercelDomainResponse {
  name: string;
  apexName: string;
  projectId: string;
  verified: boolean;
  verification?: VercelDomainVerification[];
  gitBranch?: string | null;
  redirect?: string | null;
  redirectStatusCode?: 301 | 302 | 307 | 308 | null;
  createdAt: number;
  updatedAt: number;
}

interface VercelDomainConfigResponse {
  configuredBy: "CNAME" | "A" | "http" | null;
  acceptedChallenges: ("dns-01" | "http-01")[];
  misconfigured: boolean;
}

interface VercelCertificateResponse {
  id: string;
  createdAt: number;
  expiresAt: number;
  autoRenew: boolean;
  cns: string[];
}

interface DomainStatusResult {
  domain: string;
  status: "pending" | "valid" | "invalid" | "unknown";
  configured: boolean;
  verified: boolean;
  sslStatus: "pending" | "provisioning" | "active" | "error";
  sslExpiresAt: string | null;
  configuredBy: "CNAME" | "A" | "http" | null;
  records: DomainVerificationRecord[];
  error?: string;
}

interface AddDomainResult {
  success: boolean;
  domain: string;
  verified: boolean;
  verificationRecords: DomainVerificationRecord[];
  error?: string;
}

/**
 * Make authenticated request to Vercel API
 */
async function vercelFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!VERCEL_TOKEN) {
    throw new Error("VERCEL_TOKEN is not configured");
  }

  return vercelApiRequest<T>(path, VERCEL_TOKEN, options, VERCEL_TEAM_ID);
}

/**
 * Get the Vercel project ID for an app
 */
async function getAppProjectId(appId: string): Promise<string | null> {
  const domain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  return domain?.vercel_project_id || null;
}

/**
 * Check if a subdomain is reserved
 */
export function isReservedSubdomain(subdomain: string): boolean {
  return RESERVED_SUBDOMAINS.has(subdomain.toLowerCase());
}

/**
 * Check if a custom domain is already in use by another app
 */
export async function isDomainInUse(
  domain: string,
  excludeAppId?: string,
): Promise<{
  inUse: boolean;
  appId?: string;
}> {
  const normalizedDomain = domain.toLowerCase().trim();

  const existing = await dbRead.query.appDomains.findFirst({
    where: excludeAppId
      ? and(
          eq(appDomains.custom_domain, normalizedDomain),
          ne(appDomains.app_id, excludeAppId),
        )
      : eq(appDomains.custom_domain, normalizedDomain),
  });

  return {
    inUse: !!existing,
    appId: existing?.app_id,
  };
}

/**
 * Add a custom domain to the app's Vercel project
 */
export async function addDomain(
  appId: string,
  domain: string,
): Promise<AddDomainResult> {
  // Get the app's Vercel project ID
  const projectId = await getAppProjectId(appId);
  if (!projectId) {
    return {
      success: false,
      domain,
      verified: false,
      verificationRecords: [],
      error:
        "App must be deployed before adding a custom domain. The app does not have a Vercel project yet.",
    };
  }

  // Normalize domain
  const normalizedDomain = domain.toLowerCase().trim();

  // Validate domain format
  const domainRegex = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
  if (!domainRegex.test(normalizedDomain)) {
    return {
      success: false,
      domain: normalizedDomain,
      verified: false,
      verificationRecords: [],
      error: "Invalid domain format",
    };
  }

  // Check for conflicts with other apps
  const conflict = await isDomainInUse(normalizedDomain, appId);
  if (conflict.inUse) {
    return {
      success: false,
      domain: normalizedDomain,
      verified: false,
      verificationRecords: [],
      error: "This domain is already connected to another app",
    };
  }

  logger.info("[Vercel Domains] Adding domain", {
    domain: normalizedDomain,
    appId,
    projectId,
  });

  const response = await vercelFetch<VercelDomainResponse>(
    `/v10/projects/${projectId}/domains`,
    {
      method: "POST",
      body: JSON.stringify({ name: normalizedDomain }),
    },
  );

  const verificationRecords: DomainVerificationRecord[] = (
    response.verification || []
  ).map((v) => ({
    type: v.type as "TXT" | "CNAME" | "A",
    name: v.domain,
    value: v.value,
  }));

  // Store in database
  const existingDomain = await dbRead.query.appDomains.findFirst({
    where: eq(appDomains.app_id, appId),
  });

  if (existingDomain) {
    await dbWrite
      .update(appDomains)
      .set({
        custom_domain: normalizedDomain,
        custom_domain_verified: response.verified,
        verification_records: verificationRecords,
        ssl_status: response.verified ? "provisioning" : "pending",
        vercel_domain_id: response.name,
        updated_at: new Date(),
        verified_at: response.verified ? new Date() : null,
      })
      .where(eq(appDomains.id, existingDomain.id));
  } else {
    logger.warn(
      "[Vercel Domains] No domain record found for app - app must be deployed first",
      { appId },
    );
    return {
      success: false,
      domain: normalizedDomain,
      verified: false,
      verificationRecords: [],
      error: "App must be deployed before adding a custom domain",
    };
  }

  logger.info("[Vercel Domains] Domain added", {
    domain: normalizedDomain,
    verified: response.verified,
    hasVerification: verificationRecords.length > 0,
  });

  return {
    success: true,
    domain: normalizedDomain,
    verified: response.verified,
    verificationRecords,
  };
}

/**
 * Get the current status of a domain including real SSL status
 */
export async function getDomainStatus(
  appId: string,
  domain: string,
): Promise<DomainStatusResult> {
  // Get the app's Vercel project ID
  const projectId = await getAppProjectId(appId);
  if (!projectId) {
    return {
      domain,
      status: "unknown",
      configured: false,
      verified: false,
      sslStatus: "pending",
      sslExpiresAt: null,
      configuredBy: null,
      records: [],
      error: "App does not have a Vercel project yet",
    };
  }

  const normalizedDomain = domain.toLowerCase().trim();

  // Get domain info, config, and certificate status from Vercel
  const [domainInfo, configInfo, certInfo] = await Promise.all([
    vercelFetch<VercelDomainResponse>(
      `/v9/projects/${projectId}/domains/${normalizedDomain}`,
    ).catch((error) => {
      logger.debug("[VercelDomains] Failed to fetch domain info", {
        domain: normalizedDomain,
        error: extractErrorMessage(error),
      });
      return null;
    }),
    vercelFetch<VercelDomainConfigResponse>(
      `/v6/domains/${normalizedDomain}/config`,
    ).catch((error) => {
      logger.debug("[VercelDomains] Failed to fetch domain config", {
        domain: normalizedDomain,
        error: extractErrorMessage(error),
      });
      return null;
    }),
    vercelFetch<VercelCertificateResponse[]>(
      `/v7/certs?domain=${normalizedDomain}`,
    ).catch((error) => {
      logger.debug("[VercelDomains] Failed to fetch certificates", {
        domain: normalizedDomain,
        error: extractErrorMessage(error),
      });
      return [] as VercelCertificateResponse[];
    }),
  ]);

  if (!domainInfo) {
    return {
      domain: normalizedDomain,
      status: "unknown",
      configured: false,
      verified: false,
      sslStatus: "pending",
      sslExpiresAt: null,
      configuredBy: null,
      records: [],
      error: "Domain not found in project",
    };
  }

  const records: DomainVerificationRecord[] = (
    domainInfo.verification || []
  ).map((v) => ({
    type: v.type as "TXT" | "CNAME" | "A",
    name: v.domain,
    value: v.value,
  }));

  // Determine overall status
  let status: DomainStatusResult["status"] = "pending";
  if (domainInfo.verified && configInfo && !configInfo.misconfigured) {
    status = "valid";
  } else if (configInfo?.misconfigured) {
    status = "invalid";
  }

  // Determine SSL status based on actual certificate
  let sslStatus: DomainStatusResult["sslStatus"] = "pending";
  let sslExpiresAt: string | null = null;

  const activeCert = certInfo.find((c) => c.cns.includes(normalizedDomain));
  if (activeCert) {
    const expiresAt = new Date(activeCert.expiresAt);
    sslExpiresAt = expiresAt.toISOString();

    if (expiresAt > new Date()) {
      sslStatus = "active";
    } else {
      sslStatus = "error"; // Certificate expired
    }
  } else if (domainInfo.verified && configInfo && !configInfo.misconfigured) {
    sslStatus = "provisioning";
  }

  return {
    domain: normalizedDomain,
    status,
    configured: configInfo?.configuredBy !== null,
    verified: domainInfo.verified,
    sslStatus,
    sslExpiresAt,
    configuredBy: configInfo?.configuredBy ?? null,
    records,
  };
}

/**
 * Verify a domain manually
 */
export async function verifyDomain(
  appId: string,
  domain: string,
): Promise<{ verified: boolean; error?: string }> {
  // Get the app's Vercel project ID
  const projectId = await getAppProjectId(appId);
  if (!projectId) {
    return {
      verified: false,
      error: "App does not have a Vercel project yet",
    };
  }

  const normalizedDomain = domain.toLowerCase().trim();

  logger.info("[Vercel Domains] Verifying domain", {
    domain: normalizedDomain,
    appId,
    projectId,
  });

  const response = await vercelFetch<VercelDomainResponse>(
    `/v9/projects/${projectId}/domains/${normalizedDomain}/verify`,
    { method: "POST" },
  );

  return {
    verified: response.verified,
  };
}

/**
 * Remove a custom domain from the app's Vercel project
 */
export async function removeDomain(
  appId: string,
  domain: string,
): Promise<{ success: boolean; error?: string }> {
  // Get the app's Vercel project ID
  const projectId = await getAppProjectId(appId);
  if (!projectId) {
    return {
      success: false,
      error: "App does not have a Vercel project yet",
    };
  }

  const normalizedDomain = domain.toLowerCase().trim();

  logger.info("[Vercel Domains] Removing domain", {
    domain: normalizedDomain,
    appId,
    projectId,
  });

  // Remove from Vercel project
  await vercelFetch(`/v9/projects/${projectId}/domains/${normalizedDomain}`, {
    method: "DELETE",
  });

  // Update database
  await dbWrite
    .update(appDomains)
    .set({
      custom_domain: null,
      custom_domain_verified: false,
      verification_records: [],
      ssl_status: "pending",
      vercel_domain_id: null,
      updated_at: new Date(),
      verified_at: null,
    })
    .where(eq(appDomains.app_id, appId));

  logger.info("[Vercel Domains] Domain removed", { domain: normalizedDomain });

  return { success: true };
}

/**
 * Get DNS configuration instructions for a domain
 */
export function getDnsInstructions(
  domain: string,
  isApex: boolean,
): {
  type: "A" | "CNAME";
  name: string;
  value: string;
  description: string;
}[] {
  if (isApex) {
    // Apex domain (e.g., example.com)
    return [
      {
        type: "A",
        name: "@",
        value: "76.76.21.21",
        description: "Point your apex domain to Vercel",
      },
    ];
  }

  // Subdomain (e.g., app.example.com)
  const subdomain = domain.split(".")[0];
  return [
    {
      type: "CNAME",
      name: subdomain,
      value: "cname.vercel-dns.com",
      description: "Point your subdomain to Vercel",
    },
  ];
}

/**
 * Check if a domain is an apex domain
 */
export function isApexDomain(domain: string): boolean {
  const parts = domain.split(".");
  return parts.length === 2;
}

/**
 * Validate a subdomain
 */
export function validateSubdomain(subdomain: string): {
  valid: boolean;
  error?: string;
} {
  const normalized = subdomain.toLowerCase().trim();

  // Check length
  if (normalized.length < 3) {
    return { valid: false, error: "Subdomain must be at least 3 characters" };
  }
  if (normalized.length > 63) {
    return { valid: false, error: "Subdomain must be at most 63 characters" };
  }

  // Check format
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    return {
      valid: false,
      error:
        "Subdomain can only contain lowercase letters, numbers, and hyphens",
    };
  }

  // Check reserved
  if (isReservedSubdomain(normalized)) {
    return {
      valid: false,
      error: "This subdomain is reserved and cannot be used",
    };
  }

  return { valid: true };
}

/**
 * Get all domains for an app
 */
export async function getDomainsForApp(appId: string) {
  const domains = await dbRead.query.appDomains.findMany({
    where: eq(appDomains.app_id, appId),
  });

  return domains.map((d) => ({
    id: d.id,
    subdomain: d.subdomain,
    subdomainUrl: `https://${d.subdomain}.${APP_DOMAIN}`,
    customDomain: d.custom_domain,
    customDomainUrl: d.custom_domain ? `https://${d.custom_domain}` : null,
    customDomainVerified: d.custom_domain_verified,
    sslStatus: d.ssl_status,
    isPrimary: d.is_primary,
    verificationRecords: d.verification_records,
    vercelProjectId: d.vercel_project_id,
    createdAt: d.created_at,
    verifiedAt: d.verified_at,
  }));
}

/**
 * Sync domain status from Vercel to database
 */
export async function syncDomainStatus(appId: string): Promise<void> {
  const domains = await dbRead.query.appDomains.findMany({
    where: eq(appDomains.app_id, appId),
  });

  for (const domain of domains) {
    if (!domain.custom_domain) continue;

    const status = await getDomainStatus(appId, domain.custom_domain);

    await dbWrite
      .update(appDomains)
      .set({
        custom_domain_verified: status.verified,
        ssl_status: status.sslStatus,
        verification_records: status.records,
        verified_at: status.verified ? domain.verified_at || new Date() : null,
        updated_at: new Date(),
      })
      .where(eq(appDomains.id, domain.id));

    logger.info("[Vercel Domains] Synced domain status", {
      domain: domain.custom_domain,
      verified: status.verified,
      sslStatus: status.sslStatus,
    });
  }
}

export const vercelDomainsService = {
  addDomain,
  getDomainStatus,
  verifyDomain,
  removeDomain,
  getDnsInstructions,
  isApexDomain,
  isReservedSubdomain,
  isDomainInUse,
  validateSubdomain,
  getDomainsForApp,
  syncDomainStatus,
};
