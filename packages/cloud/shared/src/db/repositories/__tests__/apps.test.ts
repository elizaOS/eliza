/**
 * AppsRepository + AppsService CRUD tests (real Drizzle schema, in-process PGlite).
 *
 * Harness: the real `dbWrite`/`dbRead` connection from `db/client.ts` resolves
 * `DATABASE_URL=pglite://memory` to an in-process PGlite instance, and
 * `pushSchema` (drizzle-kit/api) generates the EXACT DDL from the real schema
 * objects and applies it to that SAME connection — so every assertion below
 * exercises the real Drizzle schema, the real SQL, and the real jsonb columns.
 * `MOCK_REDIS=1` swaps the cache backend for the in-memory adapter so the
 * cache-eviction assertions run against a working (not no-op) cache.
 *
 * Run:
 *   bun test packages/cloud/shared/src/db/repositories/__tests__/apps.test.ts
 *
 * Self-skips LOUDLY if PGlite / drizzle-kit `pushSchema` cannot apply the schema
 * here (the repo cannot be driven against a real DB) — it never silently passes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// This suite drives an ISOLATED in-process PGlite (see docstring). When the
// ambient DATABASE_URL is a real shared Postgres (e.g. CI's
// postgresql://postgres@127.0.0.1:5432/postgres) it cannot get its own isolated
// DB — and running drizzle-kit `pushSchema` against that shared connection both
// crashes the bun test runner ("Pulling schema from database…" → hard exit) AND
// would mutate the shared schema other suites depend on. Detect that here and
// self-skip LOUDLY below (the file's stated contract: never silently pass).
const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { apiKeys } from "../../schemas/api-keys";
import { appConfig } from "../../schemas/app-config";
import { appDomains } from "../../schemas/app-domains";
import {
  appAnalytics,
  appDeploymentStatusEnum,
  appRequests,
  appReviewStatusEnum,
  apps,
  appUsers,
  userDatabaseStatusEnum,
} from "../../schemas/apps";
import { organizations } from "../../schemas/organizations";
import { users } from "../../schemas/users";
import { apiKeysRepository } from "../api-keys";
import { type App, appsRepository } from "../apps";

const PGLITE_TIMEOUT = 60_000;

const FRESH_UUID = "00000000-0000-4000-8000-00000000ffff";

let appsService: typeof import("../../../lib/services/apps").appsService;
let pgliteReady = true;

// Monotonic counter keeps seeded slugs/identities unique across tests without
// relying on Date.now() collisions in a tight loop.
let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Seed an organization and return its id (satisfies the apps FK). */
async function seedOrg(): Promise<string> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Test Org", slug: uniq("org") })
    .returning();
  return org.id;
}

/** Seed a user in an org and return its id (satisfies the apps FK). */
async function seedUser(organizationId: string): Promise<string> {
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: organizationId })
    .returning();
  return user.id;
}

/** Default seed: one org + one user, returned together for app creation. */
async function seedOrgAndUser(): Promise<{ organizationId: string; userId: string }> {
  const organizationId = await seedOrg();
  const userId = await seedUser(organizationId);
  return { organizationId, userId };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[apps.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite self-skips — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    ({ appsService } = await import("../../../lib/services/apps"));

    // Generate DDL from the real schema objects and apply it to the same
    // PGlite connection the repository queries through (`dbWrite`). Enums must
    // be in the schema map or the apps table references a missing type.
    const schema = {
      organizations,
      users,
      apiKeys,
      apps,
      appUsers,
      appAnalytics,
      appRequests,
      appDomains,
      appConfig,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      userDatabaseStatusEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    // Loud skip: a real DB is required for these assertions; never pass silently.
    console.error(
      "[apps.test] PGlite/pushSchema unavailable — cannot drive AppsRepository against a real DB. Skipping all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

/** Insert an app row directly through the repository with sane defaults. */
async function createApp(
  overrides: Partial<Parameters<typeof appsRepository.create>[0]> & {
    organization_id: string;
    created_by_user_id: string;
  },
): Promise<App> {
  const name = overrides.name ?? "Test App";
  return appsRepository.create({
    name,
    slug: overrides.slug ?? uniq("app"),
    app_url: overrides.app_url ?? "https://app.example",
    api_key_id: overrides.api_key_id ?? crypto.randomUUID(),
    ...overrides,
  });
}

describe("AppsRepository.create + reads", () => {
  test("create returns a persisted App with id/slug/api_key_id; reads find it", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const apiKeyId = crypto.randomUUID();

    const created = await createApp({
      name: "Reader App",
      slug: uniq("reader-app"),
      organization_id: organizationId,
      created_by_user_id: userId,
      api_key_id: apiKeyId,
      app_url: "https://reader.example",
    });

    expect(created.id).toBeTruthy();
    expect(created.slug).toContain("reader-app");
    expect(created.api_key_id).toBe(apiKeyId);
    expect(created.organization_id).toBe(organizationId);
    expect(created.created_by_user_id).toBe(userId);
    // Schema defaults applied by the real DB.
    expect(created.is_active).toBe(true);
    expect(created.deployment_status).toBe("draft");

    const byId = await appsRepository.findById(created.id);
    expect(byId?.id).toBe(created.id);

    const bySlug = await appsRepository.findBySlug(created.slug);
    expect(bySlug?.id).toBe(created.id);

    const byApiKey = await appsRepository.findByApiKeyId(apiKeyId);
    expect(byApiKey?.id).toBe(created.id);
  });

  test("reads for non-existent identifiers return undefined", async () => {
    if (!pgliteReady) return;
    expect(await appsRepository.findById(FRESH_UUID)).toBeUndefined();
    // Malformed (non-UUID) id short-circuits to undefined before hitting the DB.
    expect(await appsRepository.findById("not-a-uuid")).toBeUndefined();
    expect(await appsRepository.findBySlug(uniq("missing-slug"))).toBeUndefined();
    expect(await appsRepository.findByApiKeyId(FRESH_UUID)).toBeUndefined();
  });
});

describe("AppsRepository.update", () => {
  test("update returns the merged App and a fresh read reflects the change", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "Before",
      description: "old description",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    const updated = await appsRepository.update(created.id, {
      name: "After",
      description: "new description",
      allowed_origins: ["https://a.example", "https://b.example"],
      metadata: { viewKind: "release", updated: true },
    });

    expect(updated).toBeDefined();
    expect(updated?.name).toBe("After");
    expect(updated?.description).toBe("new description");
    expect(updated?.allowed_origins).toEqual(["https://a.example", "https://b.example"]);
    expect(updated?.metadata).toEqual({ viewKind: "release", updated: true });

    // Re-read from the DB: the change persisted.
    const reread = await appsRepository.findById(created.id);
    expect(reread?.name).toBe("After");
    expect(reread?.allowed_origins).toEqual(["https://a.example", "https://b.example"]);
    expect(reread?.metadata).toEqual({ viewKind: "release", updated: true });
  });

  test("update of a non-existent id returns undefined", async () => {
    if (!pgliteReady) return;
    expect(await appsRepository.update(FRESH_UUID, { name: "ghost" })).toBeUndefined();
  });

  test("update evicts the service read-cache (fresh read returns NEW value, not stale)", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "Cache Warm",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    // Warm the service cache (getById caches the row in the in-memory backend).
    const warmed = await appsService.getById(created.id);
    expect(warmed?.name).toBe("Cache Warm");

    // Mutate through the repository — its invalidateAppCacheEntries() must evict.
    await appsRepository.update(created.id, { name: "Cache Evicted" });

    // The service read must now reflect the NEW value, proving the cache key was
    // evicted rather than returning the stale cached "Cache Warm".
    const after = await appsService.getById(created.id);
    expect(after?.name).toBe("Cache Evicted");
  });
});

describe("AppsRepository.delete", () => {
  test("delete removes the row (findById -> undefined) and evicts the cache", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "To Delete",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    // Warm cache via the service so we can prove the delete evicts it.
    await appsService.getById(created.id);

    await appsRepository.delete(created.id);

    expect(await appsRepository.findById(created.id)).toBeUndefined();
    // Service read goes back to the DB (cache evicted) and finds nothing.
    expect(await appsService.getById(created.id)).toBeUndefined();
  });
});

describe("AppsRepository.listByOrganization", () => {
  test("returns only that org's apps, ordered updated_at DESC, respecting limit/offset", async () => {
    if (!pgliteReady) return;
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const userA = await seedUser(orgA);
    const userB = await seedUser(orgB);

    // Three apps in orgA, created in order; nudge updated_at so DESC is deterministic.
    const a1 = await createApp({
      name: "A1",
      organization_id: orgA,
      created_by_user_id: userA,
    });
    const a2 = await createApp({
      name: "A2",
      organization_id: orgA,
      created_by_user_id: userA,
    });
    const a3 = await createApp({
      name: "A3",
      organization_id: orgA,
      created_by_user_id: userA,
    });
    // One app in orgB — must be excluded from orgA's listing.
    const b1 = await createApp({
      name: "B1",
      organization_id: orgB,
      created_by_user_id: userB,
    });

    // Set strictly-distinct updated_at so DESC ordering is deterministic
    // regardless of wall-clock granularity: a2 (newest) > a3 > a1 (oldest).
    // The repo's update() overwrites updated_at with now(), so write the
    // timestamps directly afterward to pin the order.
    await dbWrite
      .update(apps)
      .set({ updated_at: new Date("2026-01-01T00:00:01.000Z") })
      .where(eq(apps.id, a1.id));
    await dbWrite
      .update(apps)
      .set({ updated_at: new Date("2026-01-01T00:00:02.000Z") })
      .where(eq(apps.id, a3.id));
    await dbWrite
      .update(apps)
      .set({ updated_at: new Date("2026-01-01T00:00:03.000Z") })
      .where(eq(apps.id, a2.id));

    const all = await appsRepository.listByOrganization(orgA);
    expect(all.map((a) => a.id)).toEqual([a2.id, a3.id, a1.id]);
    expect(all.every((a) => a.organization_id === orgA)).toBe(true);
    expect(all.map((a) => a.id)).not.toContain(b1.id);

    // limit clamps the page size.
    const firstTwo = await appsRepository.listByOrganization(orgA, { limit: 2 });
    expect(firstTwo.map((a) => a.id)).toEqual([a2.id, a3.id]);

    // offset skips into the ordered set.
    const skipOne = await appsRepository.listByOrganization(orgA, { limit: 2, offset: 1 });
    expect(skipOne.map((a) => a.id)).toEqual([a3.id, a1.id]);

    // orgB sees only its own app.
    const orgBList = await appsRepository.listByOrganization(orgB);
    expect(orgBList.map((a) => a.id)).toEqual([b1.id]);
  });
});

describe("App-auth attribution grants", () => {
  test("connectUser upgrades an existing analytics-created app user to an OAuth grant", async () => {
    if (!pgliteReady) return;
    const appOrg = await seedOrg();
    const callerOrg = await seedOrg();
    const appOwner = await seedUser(appOrg);
    const caller = await seedUser(callerOrg);
    const app = await createApp({
      name: "OAuth Upgrade",
      organization_id: appOrg,
      created_by_user_id: appOwner,
    });

    await appsRepository.trackAppUserActivity(app.id, caller, "0.01", {
      route: "messages",
    });
    const before = await appsRepository.findAppUser(app.id, caller);
    expect(before?.signup_source).toBeNull();

    const action = await appsRepository.connectUser({
      appId: app.id,
      userId: caller,
      signupSource: "oauth",
      ipAddress: "203.0.113.10",
      userAgent: "test-agent",
    });

    expect(action).toBe("updated");
    const after = await appsRepository.findAppUser(app.id, caller);
    expect(after?.signup_source).toBe("oauth");
    expect(after?.ip_address).toBe("203.0.113.10");
    expect(after?.user_agent).toBe("test-agent");
  });

  test("monetized X-App-Id inference attribution is public to authenticated callers", async () => {
    if (!pgliteReady) return;
    const appOrg = await seedOrg();
    const callerOrg = await seedOrg();
    const appOwner = await seedUser(appOrg);
    const sameOrgUser = await seedUser(appOrg);
    const caller = await seedUser(callerOrg);
    const app = await createApp({
      name: "Monetized App",
      organization_id: appOrg,
      created_by_user_id: appOwner,
      monetization_enabled: true,
    });
    const nonMonetizedApp = await createApp({
      name: "Internal App",
      organization_id: appOrg,
      created_by_user_id: appOwner,
      monetization_enabled: false,
    });

    const sameOrg = await appsService.getAuthorizedMonetizedAppForUser(app.id, {
      id: sameOrgUser,
      organization_id: appOrg,
    });
    expect(sameOrg?.id).toBe(app.id);

    const crossOrg = await appsService.getAuthorizedMonetizedAppForUser(app.id, {
      id: caller,
      organization_id: callerOrg,
    });
    expect(crossOrg?.id).toBe(app.id);

    await appsRepository.trackAppUserActivity(app.id, caller, "0.01", {
      route: "messages",
    });
    const analyticsOnly = await appsService.getAuthorizedMonetizedAppForUser(app.id, {
      id: caller,
      organization_id: callerOrg,
    });
    expect(analyticsOnly?.id).toBe(app.id);

    await appsRepository.connectUser({
      appId: app.id,
      userId: caller,
      signupSource: "oauth",
    });
    const oauthGranted = await appsService.getAuthorizedMonetizedAppForUser(app.id, {
      id: caller,
      organization_id: callerOrg,
    });
    expect(oauthGranted?.id).toBe(app.id);

    const nonMonetized = await appsService.getAuthorizedMonetizedAppForUser(nonMonetizedApp.id, {
      id: caller,
      organization_id: callerOrg,
    });
    expect(nonMonetized).toBeUndefined();
  });
});

describe("AppsRepository.listAll", () => {
  test("filters by is_active / is_approved", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();

    const active = await createApp({
      name: "Active",
      organization_id: organizationId,
      created_by_user_id: userId,
      is_active: true,
      is_approved: true,
    });
    const inactive = await createApp({
      name: "Inactive",
      organization_id: organizationId,
      created_by_user_id: userId,
      is_active: false,
      is_approved: false,
    });

    const activeOnly = await appsRepository.listAll({ isActive: true });
    const activeIds = activeOnly.map((a) => a.id);
    expect(activeIds).toContain(active.id);
    expect(activeIds).not.toContain(inactive.id);

    const unapprovedOnly = await appsRepository.listAll({ isApproved: false });
    const unapprovedIds = unapprovedOnly.map((a) => a.id);
    expect(unapprovedIds).toContain(inactive.id);
    expect(unapprovedIds).not.toContain(active.id);

    // No filter -> includes both.
    const everything = await appsRepository.listAll();
    const everyId = everything.map((a) => a.id);
    expect(everyId).toContain(active.id);
    expect(everyId).toContain(inactive.id);
  });
});

describe("AppsRepository.checkNameAvailability", () => {
  test("available for a fresh name", async () => {
    if (!pgliteReady) return;
    const result = await appsRepository.checkNameAvailability(uniq("Totally Fresh Name"));
    expect(result.available).toBe(true);
    expect(result.conflictType).toBeUndefined();
    expect(result.slug).toBeTruthy();
  });

  test("taken (app slug) -> available:false + slug + conflictType 'app'", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    // Create an app whose slug equals slug("Taken Brand Name").
    await createApp({
      name: "Taken Brand Name",
      slug: "taken-brand-name",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    const result = await appsRepository.checkNameAvailability("Taken Brand Name");
    expect(result.available).toBe(false);
    expect(result.slug).toBe("taken-brand-name");
    expect(result.conflictType).toBe("app");
  });

  test("subdomain-collision path -> available:false + conflictType 'subdomain'", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const anchor = await createApp({
      name: "Anchor For Subdomain",
      slug: uniq("anchor"),
      organization_id: organizationId,
      created_by_user_id: userId,
    });
    // Register a subdomain that matches slug("Subdomain Owned"), with no app of
    // that slug — so the only conflict is the subdomain.
    await dbWrite.insert(appDomains).values({ app_id: anchor.id, subdomain: "subdomain-owned" });

    const result = await appsRepository.checkNameAvailability("Subdomain Owned");
    expect(result.available).toBe(false);
    expect(result.slug).toBe("subdomain-owned");
    expect(result.conflictType).toBe("subdomain");
  });
});

describe("jsonb + scalar round-trips", () => {
  test("metadata { viewKind, foo } persists and reads back through the jsonb column", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "View Deploy App",
      organization_id: organizationId,
      created_by_user_id: userId,
      metadata: { viewKind: "release", foo: 1 },
    });
    expect(created.metadata).toEqual({ viewKind: "release", foo: 1 });

    // Re-read confirms the jsonb survived a DB round-trip (not just the returning row).
    const reread = await appsRepository.findById(created.id);
    expect(reread?.metadata).toEqual({ viewKind: "release", foo: 1 });

    // Update the jsonb and confirm the new shape persists.
    const updated = await appsRepository.update(created.id, {
      metadata: { viewKind: "draft", foo: 2, nested: { ok: true } },
    });
    expect(updated?.metadata).toEqual({ viewKind: "draft", foo: 2, nested: { ok: true } });
    const rereadAfter = await appsRepository.findById(created.id);
    expect(rereadAfter?.metadata).toEqual({ viewKind: "draft", foo: 2, nested: { ok: true } });
  });

  test("affiliate_code + app_url round-trip", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    const affiliateCode = uniq("aff");
    const created = await createApp({
      name: "Affiliate App",
      organization_id: organizationId,
      created_by_user_id: userId,
      app_url: "https://affiliate.example/app",
      affiliate_code: affiliateCode,
    });
    expect(created.affiliate_code).toBe(affiliateCode);
    expect(created.app_url).toBe("https://affiliate.example/app");

    // findByAffiliateCode resolves the row, and app_url survived the round-trip.
    const byCode = await appsRepository.findByAffiliateCode(affiliateCode);
    expect(byCode?.id).toBe(created.id);
    expect(byCode?.app_url).toBe("https://affiliate.example/app");

    // Update app_url and confirm persistence.
    const updated = await appsRepository.update(created.id, {
      app_url: "https://affiliate.example/v2",
    });
    expect(updated?.app_url).toBe("https://affiliate.example/v2");
    expect((await appsRepository.findById(created.id))?.app_url).toBe(
      "https://affiliate.example/v2",
    );
  });
});

describe("AppsService.isNameAvailable", () => {
  test("taken name -> available:false + a suggestedName", async () => {
    if (!pgliteReady) return;
    const { organizationId, userId } = await seedOrgAndUser();
    await createApp({
      name: "Service Taken",
      slug: "service-taken",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    const result = await appsService.isNameAvailable("Service Taken");
    expect(result.available).toBe(false);
    expect(result.slug).toBe("service-taken");
    expect(result.conflictType).toBe("app");
    expect(result.suggestedName).toBeTruthy();
    expect(result.suggestedName).toContain("Service Taken-");
  });

  test("available name -> available:true and no suggestedName", async () => {
    if (!pgliteReady) return;
    const result = await appsService.isNameAvailable(uniq("Service Fresh Name"));
    expect(result.available).toBe(true);
    expect(result.suggestedName).toBeUndefined();
  });
});

describe("AppsService.create organization cap", () => {
  test("treats malformed cap values as invalid and falls back to the default", async () => {
    if (!pgliteReady) return;
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "1abc";
    try {
      const { organizationId, userId } = await seedOrgAndUser();
      await createApp({
        name: "Existing App",
        organization_id: organizationId,
        created_by_user_id: userId,
      });

      const result = await appsService.create({
        name: "Allowed By Default Cap",
        organization_id: organizationId,
        created_by_user_id: userId,
        app_url: "https://default-cap.example",
      });

      expect(result.app.organization_id).toBe(organizationId);
      expect(await appsRepository.countByOrganization(organizationId)).toBe(2);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
      } else {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });

  test("rejects before API key creation when the org is already at the configured app cap", async () => {
    if (!pgliteReady) return;
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "1";
    try {
      const { organizationId, userId } = await seedOrgAndUser();
      await createApp({
        name: "Existing App",
        organization_id: organizationId,
        created_by_user_id: userId,
      });

      await expect(
        appsService.create({
          name: "Blocked App",
          organization_id: organizationId,
          created_by_user_id: userId,
          app_url: "https://blocked.example",
        }),
      ).rejects.toMatchObject({
        name: "AppCreationLimitError",
        organizationId,
        limit: 1,
      });

      expect(await appsRepository.countByOrganization(organizationId)).toBe(1);
      expect(
        await apiKeysRepository.findByUserAndName(userId, "Blocked App - App API Key"),
      ).toEqual([]);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
      } else {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });

  test("allows creation below the configured cap and persists the generated API key", async () => {
    if (!pgliteReady) return;
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "2";
    try {
      const { organizationId, userId } = await seedOrgAndUser();

      const result = await appsService.create({
        name: "Allowed App",
        organization_id: organizationId,
        created_by_user_id: userId,
        app_url: "https://allowed.example",
      });

      expect(result.app.organization_id).toBe(organizationId);
      expect(result.app.api_key_id).toBeTruthy();
      expect(result.apiKey).toMatch(/^eliza_/);
      expect(await appsRepository.countByOrganization(organizationId)).toBe(1);

      const apiKey = await apiKeysRepository.findById(result.app.api_key_id ?? "");
      expect(apiKey?.organization_id).toBe(organizationId);
      expect(apiKey?.user_id).toBe(userId);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
      } else {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });

  test("cleans up the generated API key when the transactional cap check rejects", async () => {
    if (!pgliteReady) return;
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    const originalCreateIfBelowLimit = appsRepository.createIfOrganizationBelowLimit;
    process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "25";
    try {
      const { organizationId, userId } = await seedOrgAndUser();
      appsRepository.createIfOrganizationBelowLimit = async () => undefined;

      await expect(
        appsService.create({
          name: "Race Rejected App",
          organization_id: organizationId,
          created_by_user_id: userId,
          app_url: "https://race-rejected.example",
        }),
      ).rejects.toMatchObject({
        name: "AppCreationLimitError",
        organizationId,
        limit: 25,
      });

      expect(
        await apiKeysRepository.findByUserAndName(userId, "Race Rejected App - App API Key"),
      ).toEqual([]);
      expect(await appsRepository.countByOrganization(organizationId)).toBe(0);
    } finally {
      appsRepository.createIfOrganizationBelowLimit = originalCreateIfBelowLimit;
      if (previousLimit === undefined) {
        delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
      } else {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });
});
