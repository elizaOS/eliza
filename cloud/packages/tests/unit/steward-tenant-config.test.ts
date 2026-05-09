import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

async function importStewardTenantConfig() {
  const url = new URL(
    `../../lib/services/steward-tenant-config.ts?test=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  return import(url.href) as Promise<typeof import("@/lib/services/steward-tenant-config")>;
}

describe("steward tenant config", () => {
  const originalTenantId = process.env.STEWARD_TENANT_ID;
  const originalPublicTenantId = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID;
  const originalTenantApiKey = process.env.STEWARD_TENANT_API_KEY;

  beforeEach(() => {
    mock.restore();
    process.env.NEXT_PUBLIC_STEWARD_TENANT_ID = "default-tenant";
    process.env.STEWARD_TENANT_ID = "default-tenant";
    process.env.STEWARD_TENANT_API_KEY = "default-api-key";
  });

  afterEach(() => {
    mock.restore();
    restoreOptionalEnv("NEXT_PUBLIC_STEWARD_TENANT_ID", originalPublicTenantId);
    restoreOptionalEnv("STEWARD_TENANT_ID", originalTenantId);
    restoreOptionalEnv("STEWARD_TENANT_API_KEY", originalTenantApiKey);
  });

  test("falls back to the default tenant for organizations without Steward credentials", async () => {
    mock.module("@/db/repositories/organizations", () => ({
      organizationsRepository: {
        findById: async () => ({
          id: "org-1",
          steward_tenant_id: null,
          steward_tenant_api_key: null,
        }),
      },
    }));

    const { resolveStewardTenantCredentials } = await importStewardTenantConfig();
    await expect(resolveStewardTenantCredentials({ organizationId: "org-1" })).resolves.toEqual({
      tenantId: "default-tenant",
      apiKey: "default-api-key",
    });
  });
});

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
