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

function installMocks(listForApp: () => Promise<ManagedDomain[]>) {
  const setCustomDomain = mock(async () => undefined);
  const clearCustomDomain = mock(async () => undefined);
  const unassignFromResource = mock(async () => undefined);
  const warn = mock(() => undefined);

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
      listForApp,
    },
  }));
  mock.module("@/lib/services/app-domains-compat", () => ({
    appDomainsCompat: { setCustomDomain, clearCustomDomain },
  }));
  mock.module("@/lib/utils/logger", () => ({
    logger: { error: () => undefined, info: () => undefined, warn },
  }));

  return { clearCustomDomain, setCustomDomain, unassignFromResource, warn };
}

async function loadRoute(mountPath: string) {
  const mod = await import(
    new URL(
      `../../../../apps/api/v1/apps/[id]/domains/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route(mountPath, mod.default as Hono);
  return parent;
}

describe("app domains route", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("returns 400 when app id path param is missing", async () => {
    installMocks(async () => []);
    const route = await loadRoute("/api/v1/apps/domains");

    const response = await route.request("https://api.test/api/v1/apps/domains", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "old.example" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: false; error: string };
    expect(body).toEqual({ success: false, error: "missing path params" });
  });

  test("detaching one domain keeps the next eligible custom domain primary", async () => {
    const mocks = installMocks(async () => [
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
    const route = await loadRoute("/api/v1/apps/:id/domains");

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

  test("detaching the last eligible domain clears the compatibility custom domain", async () => {
    const mocks = installMocks(async () => []);
    const route = await loadRoute("/api/v1/apps/:id/domains");

    const response = await route.request("https://api.test/api/v1/apps/app-1/domains", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "old.example" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.unassignFromResource).toHaveBeenCalledWith("detached-domain");
    expect(mocks.clearCustomDomain).toHaveBeenCalledWith("app-1");
    expect(mocks.setCustomDomain).not.toHaveBeenCalled();
  });

  test("detaching returns success when the compatibility refresh cannot list remaining domains", async () => {
    const mocks = installMocks(async () => {
      throw new Error("database timeout");
    });
    const route = await loadRoute("/api/v1/apps/:id/domains");

    const response = await route.request("https://api.test/api/v1/apps/app-1/domains", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "old.example" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.unassignFromResource).toHaveBeenCalledWith("detached-domain");
    expect(mocks.clearCustomDomain).toHaveBeenCalledWith("app-1");
    expect(mocks.setCustomDomain).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });
});
