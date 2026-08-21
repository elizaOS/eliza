/** Exercises managed-domain decoding after authentication and app ownership checks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
}));
const isAppKeyOutOfScope = mock(async () => false);
const getOwnDomainRow = mock(async () => ({
  appId: "app-1",
  domain: "example.com",
  registrar: "cloudflare",
  cloudflareZoneId: "zone-1",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));
mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: { getOwnDomainRow },
}));

const { loadCloudflareManagedDomain } = await import("./guards");

function ctx(domain: string | undefined) {
  return {
    req: {
      param: (key: string) => {
        if (key === "id") return "app-1";
        if (key === "domain") return domain;
        return undefined;
      },
    },
    get: () => undefined,
  } as never;
}

describe("loadCloudflareManagedDomain encoding", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getById.mockClear();
    isAppKeyOutOfScope.mockClear();
    getOwnDomainRow.mockClear();
  });

  test("canonical domain still reaches the managed-domain lookup", async () => {
    const result = await loadCloudflareManagedDomain(ctx("example.com"));
    expect(result).toMatchObject({
      appId: "app-1",
      domain: { domain: "example.com", cloudflareZoneId: "zone-1" },
    });
    expect(getOwnDomainRow).toHaveBeenCalledWith("org-1", "example.com");
  });

  test("canonical percent-encoded dot still decodes before lookup", async () => {
    const result = await loadCloudflareManagedDomain(ctx("example%2Ecom"));
    expect(result).toMatchObject({
      appId: "app-1",
      domain: { domain: "example.com", cloudflareZoneId: "zone-1" },
    });
    expect(getOwnDomainRow).toHaveBeenCalledWith("org-1", "example.com");
  });

  test("missing domain param is still 400 and does not look up", async () => {
    const result = await loadCloudflareManagedDomain(ctx(undefined));
    expect(result).toEqual({
      error: "missing path params",
      status: 400,
    });
    expect(getOwnDomainRow).not.toHaveBeenCalled();
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed domain %s with 400 before lookup",
    async (token) => {
      const result = await loadCloudflareManagedDomain(ctx(token));
      expect(result).toEqual({
        error: "invalid domain: malformed URL encoding",
        status: 400,
      });
      expect(getOwnDomainRow).not.toHaveBeenCalled();
    },
  );
});
