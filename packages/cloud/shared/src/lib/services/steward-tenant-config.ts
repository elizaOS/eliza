// Coordinates cloud service steward tenant config behavior behind route handlers.
import { organizationsRepository } from "../../db/repositories/organizations";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import {
  getStewardApiUrl,
  getStewardPlatformKey,
  isStewardPlatformConfigured,
} from "./steward-platform-users";

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

export interface EnsureStewardTenantOptions {
  tenantName?: string;
}

export interface EnsureStewardTenantResult extends StewardTenantCredentials {
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
      apiKey: normalizeOptionalValue(organization.steward_tenant_api_key) || getEnvStewardApiKey(),
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

  // A 409 ("already exists") is a recovery path that only needs the STATUS,
  // not the response body: it links the org to the deterministic tenant id.
  // Handle it BEFORE parsing so an empty/non-JSON conflict body (common for
  // 409 responses) still links the org instead of failing the parse guard
  // below.
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

  // error-policy:J1 A provisioning POST is a fail-closed boundary: an
  // unparseable body must NOT be collapsed into `{}` — doing so let a 2xx
  // response with a corrupt/empty body slip past the `ok === false` gate
  // below (undefined !== false) and be treated as a successful provision. Use
  // a distinct PARSE_FAILED sentinel so a genuine empty object `{}` (which is
  // a legitimate, if apiKey-less, backend shape) stays distinguishable from a
  // body we could not read at all.
  const PARSE_FAILED = Symbol("steward-tenant-parse-failed");
  const parsed = (await stewardRes.json().catch(() => PARSE_FAILED)) as
    | {
        ok?: boolean;
        apiKey?: string;
        data?: { apiKey?: string };
        error?: string;
      }
    | typeof PARSE_FAILED;

  if (parsed === PARSE_FAILED) {
    // A response whose body we cannot parse is NOT a success we can act on: we
    // have no provisioned apiKey and cannot confirm `ok`. Fail closed rather
    // than persist a tenant id with a null key. Reuse the caller-recognized
    // message prefix so the route maps it to a 502.
    throw new Error(
      `Failed to provision Steward tenant for org ${organizationId}: HTTP ${stewardRes.status} with unreadable response body`,
    );
  }

  const stewardData = parsed;

  if (!stewardRes.ok || stewardData.ok === false) {
    throw new Error(
      `Failed to provision Steward tenant for org ${organizationId}: ${
        stewardData.error ?? `HTTP ${stewardRes.status}`
      }`,
    );
  }

  const apiKey = normalizeOptionalValue(stewardData.apiKey ?? stewardData.data?.apiKey);

  if (!apiKey) {
    // error-policy:J1 A fresh-provision success MUST return a tenant-scoped
    // apiKey. Previously a 2xx-but-keyless response persisted
    // `steward_tenant_api_key: undefined` AND committed `steward_tenant_id` —
    // permanently marking the org provisioned (so `ensureStewardTenant` never
    // retries) while every downstream call silently fell back to the shared
    // platform env key instead of the tenant-scoped key (a tenant-isolation
    // degradation). Fail closed BEFORE writing the org row so a retry can
    // re-provision cleanly.
    throw new Error(
      `Failed to provision Steward tenant for org ${organizationId}: HTTP ${stewardRes.status} returned no tenant apiKey`,
    );
  }

  await organizationsRepository.update(organizationId, {
    steward_tenant_id: tenantId,
    steward_tenant_api_key: apiKey,
  });

  logger.info(`[steward-tenants] Provisioned tenant ${tenantId} for org ${organizationId}`);

  return {
    tenantId,
    apiKey,
    isNew: true,
  };
}
