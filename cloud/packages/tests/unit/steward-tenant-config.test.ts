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

  test("ensureStewardTenant returns existing tenant without touching Steward", async () => {
    const updateMock = mock(async () => undefined);
    mock.module("@/db/repositories/organizations", () => ({
      organizationsRepository: {
        findById: async () => ({
          id: "org-1",
          slug: "acme",
          steward_tenant_id: "elizacloud-acme",
          steward_tenant_api_key: "stored-api-key",
        }),
        update: updateMock,
      },
    }));
    const fetchMock = mock(async () => new Response(""));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { ensureStewardTenant } = await importStewardTenantConfig();
    await expect(ensureStewardTenant("org-1")).resolves.toEqual({
      tenantId: "elizacloud-acme",
      apiKey: "stored-api-key",
      isNew: false,
    });
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(updateMock.mock.calls.length).toBe(0);
  });

  test("ensureStewardTenant provisions on Steward and persists tenant on org", async () => {
    process.env.STEWARD_PLATFORM_KEYS = "platform-key-1";
    process.env.STEWARD_API_URL = "https://steward.example/api";

    let updateArgs: { id: string; data: Record<string, unknown> } | null = null;
    const updateMock = mock(
      async (id: string, data: Record<string, unknown>) => {
        updateArgs = { id, data };
        return undefined;
      },
    );
    mock.module("@/db/repositories/organizations", () => ({
      organizationsRepository: {
        findById: async () => ({
          id: "org-1",
          slug: "acme",
          steward_tenant_id: null,
          steward_tenant_api_key: null,
        }),
        update: updateMock,
      },
    }));
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ ok: true, apiKey: "fresh-tenant-key" }),
          { status: 201 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { ensureStewardTenant } = await importStewardTenantConfig();
    await expect(ensureStewardTenant("org-1")).resolves.toEqual({
      tenantId: "elizacloud-acme",
      apiKey: "fresh-tenant-key",
      isNew: true,
    });
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(updateArgs).toEqual({
      id: "org-1",
      data: {
        steward_tenant_id: "elizacloud-acme",
        steward_tenant_api_key: "fresh-tenant-key",
      },
    });

    delete process.env.STEWARD_PLATFORM_KEYS;
    delete process.env.STEWARD_API_URL;
  });

  test("ensureStewardTenant links org when Steward returns 409 (tenant already exists)", async () => {
    process.env.STEWARD_PLATFORM_KEYS = "platform-key-1";
    process.env.STEWARD_API_URL = "https://steward.example/api";

    let updateArgs: { id: string; data: Record<string, unknown> } | null = null;
    mock.module("@/db/repositories/organizations", () => ({
      organizationsRepository: {
        findById: async () => ({
          id: "org-1",
          slug: "acme",
          steward_tenant_id: null,
          steward_tenant_api_key: null,
        }),
        update: async (id: string, data: Record<string, unknown>) => {
          updateArgs = { id, data };
          return undefined;
        },
      },
    }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "Tenant exists" }), {
        status: 409,
      })) as unknown as typeof fetch;

    const { ensureStewardTenant } = await importStewardTenantConfig();
    await expect(ensureStewardTenant("org-1")).resolves.toEqual({
      tenantId: "elizacloud-acme",
      apiKey: "default-api-key",
      isNew: false,
    });
    expect(updateArgs).toEqual({
      id: "org-1",
      data: { steward_tenant_id: "elizacloud-acme" },
    });

    delete process.env.STEWARD_PLATFORM_KEYS;
    delete process.env.STEWARD_API_URL;
  });

  test("ensureStewardTenant falls back to default tenant when STEWARD_PLATFORM_KEYS is missing", async () => {
    delete process.env.STEWARD_PLATFORM_KEYS;
    const updateMock = mock(async () => undefined);
    mock.module("@/db/repositories/organizations", () => ({
      organizationsRepository: {
        findById: async () => ({
          id: "org-1",
          slug: "acme",
          steward_tenant_id: null,
          steward_tenant_api_key: null,
        }),
        update: updateMock,
      },
    }));

    const { ensureStewardTenant } = await importStewardTenantConfig();
    await expect(ensureStewardTenant("org-1")).resolves.toEqual({
      tenantId: "default-tenant",
      apiKey: "default-api-key",
      isNew: false,
    });
    expect(updateMock.mock.calls.length).toBe(0);
  });

  test("ensureStewardTenant throws when organization is missing", async () => {
    mock.module("@/db/repositories/organizations", () => ({
      organizationsRepository: {
        findById: async () => null,
      },
    }));

    const { ensureStewardTenant } = await importStewardTenantConfig();
    await expect(ensureStewardTenant("missing-org")).rejects.toThrow(
      /Organization missing-org not found/,
    );
  });
});

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
