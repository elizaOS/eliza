import { organizationsRepository } from "@/db/repositories/organizations";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import {
  getStewardApiUrl,
  getStewardPlatformKey,
  isStewardPlatformConfigured,
} from "@/lib/services/steward-platform-users";
import { logger } from "@/lib/utils/logger";

export const DEFAULT_STEWARD_TENANT_ID = "elizacloud";

export interface StewardTenantCredentials {
  tenantId: string;
  apiKey?: string;
}

export interface ResolveStewardTenantCredentialsOptions {
  organizationId?: string;
  tenantId?: string | null;
  apiKey?: string | null;
}

function normalizeOptionalValue(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getEnvStewardApiKey(): string | undefined {
  return normalizeOptionalValue(getCloudAwareEnv().STEWARD_TENANT_API_KEY);
}

export function resolveDefaultStewardTenantId(): string {
  const env = getCloudAwareEnv();
  return (
    normalizeOptionalValue(env.NEXT_PUBLIC_STEWARD_TENANT_ID) ||
    normalizeOptionalValue(env.STEWARD_TENANT_ID) ||
    DEFAULT_STEWARD_TENANT_ID
  );
}

export async function resolveStewardTenantCredentials(
  options: ResolveStewardTenantCredentialsOptions = {},
): Promise<StewardTenantCredentials> {
  const explicitTenantId = normalizeOptionalValue(options.tenantId);
  if (explicitTenantId) {
    return {
      tenantId: explicitTenantId,
      apiKey: normalizeOptionalValue(options.apiKey) || getEnvStewardApiKey(),
    };
  }

  if (options.organizationId) {
    const organization = await organizationsRepository.findById(options.organizationId);
    if (!organization) {
      throw new Error(`Organization ${options.organizationId} not found`);
    }

    const tenantId = normalizeOptionalValue(organization.steward_tenant_id);
    return {
      tenantId: tenantId || resolveDefaultStewardTenantId(),
      apiKey:
        normalizeOptionalValue(options.apiKey) ||
        normalizeOptionalValue(organization.steward_tenant_api_key) ||
        getEnvStewardApiKey(),
    };
  }

  return {
    tenantId: resolveDefaultStewardTenantId(),
    apiKey: normalizeOptionalValue(options.apiKey) || getEnvStewardApiKey(),
  };
}

/**
 * Ensures a Steward tenant exists for the given organization and returns its
 * credentials. Idempotent: if the org already has a `steward_tenant_id`, returns
 * it without touching Steward. Otherwise calls Steward's platform tenant-create
 * API with the configured platform key, persists the assignment on the org,
 * and returns the new credentials.
 *
 * Handles two transient states cleanly:
 *  - 409 from Steward (tenant exists in Steward but not linked in our DB,
 *    typically from a previous half-completed provision): re-link without an
 *    API key. Caller will pick up `STEWARD_TENANT_API_KEY` from env if needed.
 *  - Steward not configured (`STEWARD_PLATFORM_KEYS` empty): falls back to the
 *    default tenant rather than throwing, so non-production environments still
 *    boot. Sandbox creation in such environments will hit the existing
 *    `tenant not found` path against the default tenant, which is the same
 *    behavior as before.
 *
 * This is the auto-provisioning seam called from server-context flows
 * (e.g. `docker-sandbox-provider.createSandbox`) where we don't have a user
 * request to drive the explicit `POST /api/v1/steward/tenants` route. The route
 * handler delegates to this helper to keep both code paths in sync.
 */
export interface EnsureStewardTenantOptions {
  /** Display name forwarded to Steward when creating the tenant. Defaults to
   *  `ElizaCloud — <org.slug>`. */
  tenantName?: string;
}

export interface EnsureStewardTenantResult extends StewardTenantCredentials {
  /** `true` when a new tenant was provisioned on Steward in this call;
   *  `false` when an existing tenant was returned (either persisted on the org
   *  or already present on Steward and re-linked from a 409). */
  isNew: boolean;
}

export async function ensureStewardTenant(
  organizationId: string,
  options: EnsureStewardTenantOptions = {},
): Promise<EnsureStewardTenantResult> {
  const organization = await organizationsRepository.findById(organizationId);
  if (!organization) {
    throw new Error(`Organization ${organizationId} not found`);
  }

  const existingTenantId = normalizeOptionalValue(organization.steward_tenant_id);
  if (existingTenantId) {
    return {
      tenantId: existingTenantId,
      apiKey:
        normalizeOptionalValue(organization.steward_tenant_api_key) ||
        getEnvStewardApiKey(),
      isNew: false,
    };
  }

  if (!isStewardPlatformConfigured()) {
    logger.warn(
      "[steward-tenants] STEWARD_PLATFORM_KEYS not configured; falling back to default tenant for org",
      { organizationId },
    );
    return {
      tenantId: resolveDefaultStewardTenantId(),
      apiKey: getEnvStewardApiKey(),
      isNew: false,
    };
  }

  const tenantId = `elizacloud-${organization.slug}`;
  const tenantName =
    normalizeOptionalValue(options.tenantName) ?? `ElizaCloud — ${organization.slug}`;

  const platformKey = getStewardPlatformKey();
  const stewardRes = await fetch(`${getStewardApiUrl()}/platform/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Steward-Platform-Key": platformKey,
    },
    body: JSON.stringify({ id: tenantId, name: tenantName }),
  });

  const stewardData = (await stewardRes.json().catch(() => ({}))) as {
    ok?: boolean;
    apiKey?: string;
    data?: { apiKey?: string };
    error?: string;
  };

  if (stewardRes.status === 409) {
    logger.warn(
      `[steward-tenants] Tenant ${tenantId} already exists in Steward, linking org ${organizationId}`,
    );
    await organizationsRepository.update(organizationId, {
      steward_tenant_id: tenantId,
    });
    return {
      tenantId,
      apiKey: getEnvStewardApiKey(),
      isNew: false,
    };
  }

  if (!stewardRes.ok || stewardData.ok === false) {
    throw new Error(
      `Failed to provision Steward tenant for org ${organizationId}: ${
        stewardData.error ?? `HTTP ${stewardRes.status}`
      }`,
    );
  }

  const apiKey = normalizeOptionalValue(
    stewardData.apiKey ?? stewardData.data?.apiKey,
  );

  await organizationsRepository.update(organizationId, {
    steward_tenant_id: tenantId,
    steward_tenant_api_key: apiKey,
  });

  logger.info(
    `[steward-tenants] Provisioned tenant ${tenantId} for org ${organizationId}`,
  );

  return {
    tenantId,
    apiKey: apiKey || getEnvStewardApiKey(),
    isNew: true,
  };
}
