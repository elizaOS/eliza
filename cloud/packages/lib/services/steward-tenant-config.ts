import { organizationsRepository } from "@/db/repositories/organizations";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

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
