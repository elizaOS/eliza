/**
 * The Refresh button on a verified custom domain calls
 * POST /api/v1/apps/:id/domains/verify. A DNS failure that says nothing about
 * the TXT record (timeout, resolver error) must not downgrade a verified
 * domain, because an unverified row stops resolving at once. A missing or
 * wrong record proves control is lost and still unverifies it.
 * Real route, PGlite database, caller authenticated as the app's
 * organization; only the DNS lookup is stubbed.
 */
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { promises as dns } from "node:dns";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const ORG = "11111111-1111-4111-8111-1111111111d1";
const USER = "22222222-2222-4222-8222-2222222222d1";
const APP = "66666666-6666-4666-8666-6666666666d1";

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: USER,
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
    role: "owner",
  }),
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "@elizaos/cloud-shared/db/client"
);
const schemas = await import("@elizaos/cloud-shared/db/schemas");
const { managedDomainsService } = await import(
  "@elizaos/cloud-shared/lib/services/managed-domains"
);
const { Hono } = await import("hono");
const { default: verifyRoute } = await import(
  "../v1/apps/[id]/domains/verify/route.ts"
);

const app = new Hono();
app.route("/api/v1/apps/:id/domains/verify", verifyRoute);
const workerEnv = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      appDeploymentStatusEnum: schemas.appDeploymentStatusEnum,
      appReviewStatusEnum: schemas.appReviewStatusEnum,
      organizations: schemas.organizations,
      users: schemas.users,
      apps: schemas.apps,
      apiKeys: schemas.apiKeys,
      userCharacters: schemas.userCharacters,
      containers: schemas.containers,
      mcpPricingTypeEnum: schemas.mcpPricingTypeEnum,
      mcpStatusEnum: schemas.mcpStatusEnum,
      userMcps: schemas.userMcps,
      domainRegistrarEnum: schemas.domainRegistrarEnum,
      domainNameserverModeEnum: schemas.domainNameserverModeEnum,
      domainResourceTypeEnum: schemas.domainResourceTypeEnum,
      domainModerationStatusEnum: schemas.domainModerationStatusEnum,
      domainStatusEnum: schemas.domainStatusEnum,
      managedDomains: schemas.managedDomains,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite
    .insert(schemas.organizations)
    .values({ id: ORG, name: "Org", slug: "org-domains" });
  await dbWrite.insert(schemas.users).values({
    id: USER,
    organization_id: ORG,
    steward_user_id: "steward-domains",
    email: "owner@example.test",
  });
  await dbWrite.insert(schemas.apps).values({
    id: APP,
    name: "App",
    slug: "app-domains",
    organization_id: ORG,
    created_by_user_id: USER,
    app_url: "https://app.example.test",
  });
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  mock.restore();
});

async function verifiedDomain(domain: string) {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const [row] = await dbWrite
    .insert(schemas.managedDomains)
    .values({
      organizationId: ORG,
      domain,
      registrar: "external",
      nameserverMode: "external",
      status: "active",
      verified: true,
      verifiedAt: threeDaysAgo,
      verificationToken: "token-123",
      appId: APP,
      resourceType: "app",
      createdAt: threeDaysAgo,
    } as never)
    .returning();
  return row;
}

async function verify(domain: string) {
  const response = await app.request(
    `/api/v1/apps/${APP}/domains/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain }),
    },
    workerEnv,
  );
  return (await response.json()) as { verified?: boolean };
}

function dnsError(code: string) {
  return () =>
    Promise.reject(Object.assign(new Error(`queryTxt ${code}`), { code }));
}

test.each([
  ["the lookup times out", dnsError("ETIMEOUT")],
  ["the resolver fails", dnsError("ESERVFAIL")],
])("Refresh keeps a verified domain when %s", async (_case, lookup) => {
  const domain = `shop-${Math.random().toString(36).slice(2, 8)}.example.com`;
  await verifiedDomain(domain);
  const resolveTxt = spyOn(dns, "resolveTxt").mockImplementation(
    lookup as never,
  );
  try {
    expect((await verify(domain)).verified).toBe(true);
  } finally {
    resolveTxt.mockRestore();
  }
  expect((await managedDomainsService.getDomainByName(domain))?.verified).toBe(
    true,
  );
});

test.each([
  ["the TXT record is gone", dnsError("ENODATA")],
  ["the hostname no longer exists", dnsError("ENOTFOUND")],
  ["the TXT record holds another token", () => Promise.resolve([["other"]])],
])(
  "Refresh unverifies a domain whose control is lost: %s",
  async (_case, lookup) => {
    const domain = `lost-${Math.random().toString(36).slice(2, 8)}.example.com`;
    await verifiedDomain(domain);
    const resolveTxt = spyOn(dns, "resolveTxt").mockImplementation(
      lookup as never,
    );
    try {
      expect((await verify(domain)).verified).toBe(false);
    } finally {
      resolveTxt.mockRestore();
    }
    // It no longer resolves and no longer holds the hostname.
    expect(await managedDomainsService.getDomainByName(domain)).toBeNull();
  },
);
