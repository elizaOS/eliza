/**
 * A verified external custom domain stays verified while it is attached
 * (Refresh does not downgrade it). Detaching it must release it: the row is
 * deleted, so the hostname stops resolving and its exclusive slot is free for
 * whoever controls the domain now. A Cloudflare-registered domain keeps its
 * row on detach, because its registration stays active. The stale cron
 * reclaims only rows that were never verified.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const ORG = "11111111-1111-4111-8111-1111111111e1";
const OTHER_ORG = "11111111-1111-4111-8111-1111111111e2";
const USER = "22222222-2222-4222-8222-2222222222e1";
const APP = "66666666-6666-4666-8666-6666666666e1";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../../../db/client");
const schemas = await import("../../../db/schemas");
const { managedDomainsService } = await import("../managed-domains");

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
  await dbWrite.insert(schemas.organizations).values([
    { id: ORG, name: "Org", slug: "org-detach" },
    { id: OTHER_ORG, name: "New owner", slug: "org-new-owner" },
  ]);
  await dbWrite.insert(schemas.users).values({
    id: USER,
    organization_id: ORG,
    steward_user_id: "steward-detach",
    email: "owner@example.test",
  });
  await dbWrite.insert(schemas.apps).values({
    id: APP,
    name: "App",
    slug: "app-detach",
    organization_id: ORG,
    created_by_user_id: USER,
    app_url: "https://app.example.test",
  });
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

async function attachedVerified(domain: string, registrar: "external" | "cloudflare") {
  const [row] = await dbWrite
    .insert(schemas.managedDomains)
    .values({
      organizationId: ORG,
      domain,
      registrar,
      nameserverMode: registrar === "cloudflare" ? "cloudflare" : "external",
      status: "active",
      verified: true,
      verifiedAt: new Date(),
      verificationToken: "token-123",
      appId: APP,
      resourceType: "app",
    } as never)
    .returning();
  return row;
}

test("detaching a verified external domain releases its hostname", async () => {
  const row = await attachedVerified("shop.example.com", "external");
  expect((await managedDomainsService.getDomainByName("shop.example.com"))?.id).toBe(row.id);

  await managedDomainsService.unassignFromResource(row.id);

  // No exclusive owner is left, so another organization can attach it, and
  // the app no longer lists it as a sign-in origin.
  expect(await managedDomainsService.getDomainByName("shop.example.com")).toBeNull();
  expect(await managedDomainsService.getOwnDomainRow(ORG, "shop.example.com")).toBeNull();
  expect(await managedDomainsService.listVerifiedAppOrigins(APP)).not.toContain(
    "https://shop.example.com",
  );
  const fresh = await managedDomainsService.insertExternalDomain({
    organizationId: OTHER_ORG,
    domain: "shop.example.com",
    verificationToken: "token-new-owner",
  });
  expect(fresh.organizationId).toBe(OTHER_ORG);
});

test("detaching a Cloudflare-registered domain keeps its registration row", async () => {
  const row = await attachedVerified("bought.example.com", "cloudflare");

  const detached = await managedDomainsService.unassignFromResource(row.id);

  expect({ appId: detached.appId, verified: detached.verified }).toEqual({
    appId: null,
    verified: true,
  });
  expect((await managedDomainsService.getOwnDomainRow(ORG, "bought.example.com"))?.id).toBe(row.id);
});

test("the stale cron reclaims only external rows that were never verified", async () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const [neverVerified, lostControl] = await dbWrite
    .insert(schemas.managedDomains)
    .values([
      {
        organizationId: ORG,
        domain: "squat.example.com",
        registrar: "external",
        nameserverMode: "external",
        status: "pending",
        verified: false,
        verificationToken: "t1",
        createdAt: threeDaysAgo,
      },
      {
        // Verified once, then Refresh found its TXT record gone.
        organizationId: ORG,
        domain: "lapsed.example.com",
        registrar: "external",
        nameserverMode: "external",
        status: "active",
        verified: false,
        verifiedAt: threeDaysAgo,
        verificationToken: "t2",
        appId: APP,
        resourceType: "app",
        createdAt: threeDaysAgo,
      },
    ] as never)
    .returning();

  await managedDomainsService.releaseStaleUnverifiedExternals(48 * 60 * 60 * 1000);

  expect(await managedDomainsService.getDomainById(neverVerified.id)).toBeNull();
  // Kept for its owner to restore the record, but it neither resolves nor
  // holds the hostname, so the domain's new owner can attach it.
  expect((await managedDomainsService.getDomainById(lostControl.id))?.appId).toBe(APP);
  expect(await managedDomainsService.getDomainByName("lapsed.example.com")).toBeNull();
});
