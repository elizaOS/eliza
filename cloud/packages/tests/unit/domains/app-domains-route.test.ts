import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

interface ManagedDomain {
  id: string;
  domain: string;
  organizationId: string;
  appId: string | null;
  registrar: "cloudflare" | "external";
  status: string;
  verified: boolean;
  sslStatus?: string | null;
  expiresAt?: Date | null;
  cloudflareZoneId?: string | null;
  verificationToken?: string | null;
}

function installMocks(domainsAfterDetach: ManagedDomain[]) {
  const setCustomDomain = mock(async () => undefined);
  const clearCustomDomain = mock(async () => undefined);
  const unassignFromResource = mock(async () => undefined);

  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => ({ organization_id: "org-1" }),
  }));
  mock.module("@/lib/services/apps", () => ({
    appsService: {
      getById: async () => ({ id: "app-1", organization_id: "org-1" }),
    },
  }));
  mock.module("@/lib/services/managed-domains", () => ({
    managedDomainsService: {
      getDomainByName: async () => ({
        id: "detached-domain",
        domain: "old.example",
        organizationId: "org-1",
        appId: "app-1",
        registrar: "cloudflare",
        status: "active",
        verified: true,
      }),
      unassignFromResource,
      listForApp: async () => domainsAfterDetach,
    },
  }));
  mock.module("@/lib/services/app-domains-compat", () => ({
    appDomainsCompat: { setCustomDomain, clearCustomDomain },
  }));
  mock.module("@/lib/utils/logger", () => ({
    logger: { error: () => undefined, info: () => undefined },
  }));

  return { clearCustomDomain, setCustomDomain, unassignFromResource };
}

async function loadRoute() {
  const mod = await import(
    new URL(
      `../../../../apps/api/v1/apps/[id]/domains/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/apps/:id/domains", mod.default as Hono);
  return parent;
}

describe("app domains route", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("detaching one domain keeps the next eligible custom domain primary", async () => {
    const mocks = installMocks([
      {
        id: "detached-domain",
        domain: "old.example",
        organizationId: "org-1",
        appId: "app-1",
        registrar: "cloudflare",
        status: "active",
        verified: true,
      },
      {
        id: "remaining-domain",
        domain: "new.example",
        organizationId: "org-1",
        appId: "app-1",
        registrar: "external",
        status: "active",
        verified: true,
      },
    ]);
    const route = await loadRoute();

    const response = await route.request("https://api.test/api/v1/apps/app-1/domains", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "old.example" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.unassignFromResource).toHaveBeenCalledWith("detached-domain");
    expect(mocks.setCustomDomain).toHaveBeenCalledWith({
      appId: "app-1",
      domain: "new.example",
      verified: true,
    });
    expect(mocks.clearCustomDomain).not.toHaveBeenCalled();
  });
});
