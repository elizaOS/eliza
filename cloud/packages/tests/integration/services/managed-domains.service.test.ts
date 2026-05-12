/**
 * Integration tests for managed-domains-service against the real local
 * postgres. Exercises the actual DB writes for insertCloudflareRegisteredDomain,
 * insertExternalDomain, assignToResource, syncStatus, unassignFromResource.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { dbWrite } from "@/db/client";
import { apps } from "@/db/schemas/apps";
import { managedDomains } from "@/db/schemas/managed-domains";
import { organizations } from "@/db/schemas/organizations";
import { users } from "@/db/schemas/users";
import { appsService } from "@/lib/services/apps";
import { managedDomainsService } from "@/lib/services/managed-domains";

// Test fixture identifiers — unique per test run to avoid collisions
const SUFFIX = `cfdomain-test-${Date.now()}`;

let orgId: string;
let userId: string;
let appId: string;

beforeAll(async () => {
  // Create user
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `test-managed-domains-${crypto.randomUUID()}`,
      email: `${SUFFIX}@test.local`,
      name: `cf domain test ${SUFFIX}`,
    })
    .returning();
  if (!user) throw new Error("failed to create test user");
  userId = user.id;

  // Create org
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name: `cf-domain-test-org-${SUFFIX}`,
      slug: `cf-domain-test-${SUFFIX}`,
    })
    .returning();
  if (!org) throw new Error("failed to create test org");
  orgId = org.id;

  // Create app
  const [app] = await dbWrite
    .insert(apps)
    .values({
      organization_id: orgId,
      name: `test-app-${SUFFIX}`,
      slug: `test-app-${SUFFIX}`,
      app_url: "https://test.placeholder.invalid",
      created_by_user_id: userId,
    })
    .returning();
  if (!app) throw new Error("failed to create test app");
  appId = app.id;
});

afterAll(async () => {
  // Clean up any test domains we may have left behind
  if (orgId) {
    await dbWrite.delete(managedDomains).where(eq(managedDomains.organizationId, orgId));
  }
  if (appId) {
    await dbWrite.delete(apps).where(eq(apps.id, appId));
  }
  if (orgId) {
    await dbWrite.delete(organizations).where(eq(organizations.id, orgId));
  }
  if (userId) {
    await dbWrite.delete(users).where(eq(users.id, userId));
  }
});

describe("managedDomainsService — real DB", () => {
  test("insertCloudflareRegisteredDomain persists with cloudflare registrar + zone id", async () => {
    const created = await managedDomainsService.insertCloudflareRegisteredDomain({
      organizationId: orgId,
      domain: `cf-${SUFFIX}.com`,
      cloudflareZoneId: "zone-test-abc",
      cloudflareRegistrationId: "reg-test-abc",
      purchasePriceCents: 1495,
      renewalPriceCents: 1495,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      registrantInfo: null,
    });
    expect(created.id).toBeTruthy();
    expect(created.registrar).toBe("cloudflare");
    expect(created.nameserverMode).toBe("cloudflare");
    expect(created.cloudflareZoneId).toBe("zone-test-abc");
    expect(created.cloudflareRegistrationId).toBe("reg-test-abc");
    expect(created.status).toBe("active");
    expect(created.verified).toBe(true);
    expect(created.paymentMethod).toBe("credits");
  });

  test("upsertCloudflareRegisteredDomain can persist pending registration before zone exists", async () => {
    const created = await managedDomainsService.upsertCloudflareRegisteredDomain({
      organizationId: orgId,
      domain: `pending-${SUFFIX}.com`,
      cloudflareRegistrationId: "reg-pending",
      purchasePriceCents: 1020,
      renewalPriceCents: 1020,
      status: "pending",
      verified: false,
      autoRenew: false,
    });
    expect(created.registrar).toBe("cloudflare");
    expect(created.nameserverMode).toBe("cloudflare");
    expect(created.status).toBe("pending");
    expect(created.verified).toBe(false);
    expect(created.cloudflareZoneId).toBeNull();
    expect(created.cloudflareRegistrationId).toBe("reg-pending");
    expect(created.purchasePrice).toBe("1020");
  });

  test("upsertCloudflareRegisteredDomain upgrades an existing external row", async () => {
    const external = await managedDomainsService.insertExternalDomain({
      organizationId: orgId,
      domain: `upgrade-${SUFFIX}.com`,
      verificationToken: "tok-upgrade",
    });
    expect(external.registrar).toBe("external");

    const upgraded = await managedDomainsService.upsertCloudflareRegisteredDomain({
      organizationId: orgId,
      domain: `upgrade-${SUFFIX}.com`,
      cloudflareZoneId: "zone-upgrade",
      cloudflareRegistrationId: "reg-upgrade",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      status: "active",
      verified: true,
      autoRenew: false,
    });
    expect(upgraded.id).toBe(external.id);
    expect(upgraded.registrar).toBe("cloudflare");
    expect(upgraded.nameserverMode).toBe("cloudflare");
    expect(upgraded.status).toBe("active");
    expect(upgraded.verified).toBe(true);
    expect(upgraded.verificationToken).toBeNull();
    expect(upgraded.cloudflareZoneId).toBe("zone-upgrade");
    expect(upgraded.cloudflareRegistrationId).toBe("reg-upgrade");
  });

  test("insertExternalDomain persists with external registrar + verification token", async () => {
    const created = await managedDomainsService.insertExternalDomain({
      organizationId: orgId,
      domain: `ext-${SUFFIX}.com`,
      verificationToken: "eliza-verify-test-token-1234",
    });
    expect(created.registrar).toBe("external");
    expect(created.verificationToken).toBe("eliza-verify-test-token-1234");
    expect(created.verified).toBe(false);
    expect(created.status).toBe("pending");
    expect(created.autoRenew).toBe(false);
  });

  test("assignToResource sets the polymorphic FK + clears the others", async () => {
    const created = await managedDomainsService.insertExternalDomain({
      organizationId: orgId,
      domain: `assign-${SUFFIX}.com`,
      verificationToken: "tok-2",
    });
    const assigned = await managedDomainsService.assignToResource(created.id, {
      type: "app",
      id: appId,
    });
    expect(assigned.resourceType).toBe("app");
    expect(assigned.appId).toBe(appId);
    expect(assigned.containerId).toBeNull();
    expect(assigned.agentId).toBeNull();
    expect(assigned.mcpId).toBeNull();
  });

  test("verified app domains are accepted as OAuth origins", async () => {
    const created = await managedDomainsService.insertCloudflareRegisteredDomain({
      organizationId: orgId,
      domain: `oauth-${SUFFIX}.com`,
      cloudflareZoneId: "zone-oauth",
      cloudflareRegistrationId: "reg-oauth",
      purchasePriceCents: 1495,
      renewalPriceCents: 1495,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      registrantInfo: null,
    });
    await managedDomainsService.assignToResource(created.id, {
      type: "app",
      id: appId,
    });

    const origins = await managedDomainsService.listVerifiedAppOrigins(appId);
    expect(origins).toContain(`https://oauth-${SUFFIX}.com`);
    expect(
      await appsService.validateOrigin(appId, `https://oauth-${SUFFIX}.com/apps/test-app/`),
    ).toBe(true);
    expect(await appsService.validateOrigin(appId, "https://evil.example.com")).toBe(false);
  });

  test("unassignFromResource nulls all polymorphic FKs", async () => {
    const created = await managedDomainsService.insertExternalDomain({
      organizationId: orgId,
      domain: `unassign-${SUFFIX}.com`,
      verificationToken: "tok-3",
    });
    await managedDomainsService.assignToResource(created.id, { type: "app", id: appId });
    const unassigned = await managedDomainsService.unassignFromResource(created.id);
    expect(unassigned.resourceType).toBeNull();
    expect(unassigned.appId).toBeNull();
  });

  test("syncStatus updates verified + sets verifiedAt the FIRST time it flips", async () => {
    const created = await managedDomainsService.insertExternalDomain({
      organizationId: orgId,
      domain: `sync-${SUFFIX}.com`,
      verificationToken: "tok-4",
    });
    expect(created.verified).toBe(false);
    expect(created.verifiedAt).toBeNull();

    const flipped = await managedDomainsService.syncStatus({
      domainId: created.id,
      verified: true,
      status: "active",
    });
    expect(flipped.verified).toBe(true);
    expect(flipped.verifiedAt).toBeInstanceOf(Date);
    const firstVerifiedAt = flipped.verifiedAt;

    // Second sync with verified=true again — verifiedAt should NOT bump
    const second = await managedDomainsService.syncStatus({
      domainId: created.id,
      verified: true,
    });
    expect(second.verifiedAt?.getTime()).toBe(firstVerifiedAt?.getTime());
  });

  test("syncStatus persists healthCheckError + lastHealthCheck", async () => {
    const created = await managedDomainsService.insertCloudflareRegisteredDomain({
      organizationId: orgId,
      domain: `health-${SUFFIX}.com`,
      cloudflareZoneId: "z2",
      cloudflareRegistrationId: "r2",
      purchasePriceCents: 1495,
      renewalPriceCents: 1495,
      expiresAt: null,
      registrantInfo: null,
    });

    const t0 = Date.now();
    const updated = await managedDomainsService.syncStatus({
      domainId: created.id,
      healthCheckError: "test failure",
    });
    expect(updated.healthCheckError).toBe("test failure");
    expect(updated.lastHealthCheck).toBeInstanceOf(Date);
    expect(updated.lastHealthCheck!.getTime()).toBeGreaterThanOrEqual(t0);

    // Setting it back to null clears it
    const cleared = await managedDomainsService.syncStatus({
      domainId: created.id,
      healthCheckError: null,
    });
    expect(cleared.healthCheckError).toBeNull();
  });

  test("getDomainByName + listForApp + listForOrganization round-trip", async () => {
    const created = await managedDomainsService.insertExternalDomain({
      organizationId: orgId,
      domain: `read-${SUFFIX}.com`,
      verificationToken: "tok-5",
    });
    await managedDomainsService.assignToResource(created.id, { type: "app", id: appId });

    const byName = await managedDomainsService.getDomainByName(`read-${SUFFIX}.com`);
    expect(byName?.id).toBe(created.id);

    const forApp = await managedDomainsService.listForApp(orgId, appId);
    expect(forApp.some((d) => d.id === created.id)).toBe(true);

    const forOrg = await managedDomainsService.listForOrganization(orgId);
    expect(forOrg.length).toBeGreaterThanOrEqual(1);
    expect(forOrg.some((d) => d.id === created.id)).toBe(true);
  });
});
