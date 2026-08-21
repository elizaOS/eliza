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
 * Fails LOUDLY if PGlite / drizzle-kit `pushSchema` cannot apply the schema
 * here (the repo cannot be driven against a real DB) — it never silently passes.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// This suite drives an ISOLATED in-process PGlite (see docstring). When the
// ambient DATABASE_URL is a real shared Postgres (e.g. CI's
// postgresql://postgres@127.0.0.1:5432/postgres) it cannot get its own isolated
// DB — and running drizzle-kit `pushSchema` against that shared connection both
// crashes the bun test runner ("Pulling schema from database…" → hard exit) AND
// would mutate the shared schema other suites depend on. Detect that here and
// fail LOUDLY below (the file's stated contract: never silently pass).
const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
const PREVIOUS_CACHE_ENABLED = process.env.CACHE_ENABLED;
const PREVIOUS_MOCK_REDIS = process.env.MOCK_REDIS;
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.CACHE_ENABLED = "true";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { buildMobileAppAuthCredentialProvenance } from "../../mobile-app-auth-credential-policy";
import { apiKeys } from "../../schemas/api-keys";
import { appConfig } from "../../schemas/app-config";
import { appDomains } from "../../schemas/app-domains";
import type { AppFrontendDeployment } from "../../schemas/app-frontend-deployments";
import {
  appAnalytics,
  appDeploymentStatusEnum,
  appRequests,
  appReviewStatusEnum,
  apps,
  appUsers,
  userDatabaseStatusEnum,
} from "../../schemas/apps";
import { mobileAppAuthGrants } from "../../schemas/mobile-app-auth-grants";
import { organizations } from "../../schemas/organizations";
import { users } from "../../schemas/users";
import { apiKeysRepository } from "../api-keys";
import { type App, appsRepository } from "../apps";
import { organizationsRepository } from "../organizations";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 60_000;

const FRESH_UUID = "00000000-0000-4000-8000-00000000ffff";

let appsService: typeof import("../../../lib/services/apps").appsService;
let getMaxAppsPerOrg: typeof import("../../../lib/services/apps").getMaxAppsPerOrg;
let appAnalyticsService: typeof import("../../../lib/services/app-analytics").appAnalyticsService;
let cache: typeof import("../../../lib/cache/client").cache;
let CacheKeys: typeof import("../../../lib/cache/keys").CacheKeys;
let apiKeysService: typeof import("../../../lib/services/api-keys").apiKeysService;
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
      "[apps.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    ({ appsService, getMaxAppsPerOrg } = await import("../../../lib/services/apps"));
    ({ appAnalyticsService } = await import("../../../lib/services/app-analytics"));
    ({ cache } = await import("../../../lib/cache/client"));
    ({ CacheKeys } = await import("../../../lib/cache/keys"));
    ({ apiKeysService } = await import("../../../lib/services/api-keys"));

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
      mobileAppAuthGrants,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();

    // pushSchema only derives DDL from the Drizzle schema objects above — it
    // never runs hand-written SQL migrations. The credential-tombstone
    // trigger (0279) lives only in a raw migration file (Drizzle has no
    // trigger primitive), so it must be applied here explicitly for the
    // cascade-deletion tests below to exercise the real trigger rather than
    // asserting against a DB that doesn't have it installed.
    const tombstoneTriggerMigration = readFileSync(
      new URL(
        "../../migrations/0280_mobile_app_auth_credential_tombstone_trigger.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of tombstoneTriggerMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(statement);
    }
  } catch (error) {
    // error-policy:J4 — a missing PGlite/schema capability is retained as an
    // explicit failed fixture state that every integration assertion checks.
    pgliteReady = false;
    // Loud skip: a real DB is required for these assertions; never pass silently.
    console.error(
      "[apps.test] PGlite/pushSchema unavailable — cannot drive AppsRepository against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  try {
    await closeDatabaseConnectionsForTests();
  } finally {
    if (PREVIOUS_CACHE_ENABLED === undefined) delete process.env.CACHE_ENABLED;
    else process.env.CACHE_ENABLED = PREVIOUS_CACHE_ENABLED;

    if (PREVIOUS_MOCK_REDIS === undefined) delete process.env.MOCK_REDIS;
    else process.env.MOCK_REDIS = PREVIOUS_MOCK_REDIS;
  }
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
    expect(pgliteReady).toBe(true);
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

    expect(await appsRepository.findByIdInOrganizationForWrite(created.id, organizationId)).toEqual(
      created,
    );
    const otherOrganizationId = await seedOrg();
    expect(
      await appsRepository.findByIdInOrganizationForWrite(created.id, otherOrganizationId),
    ).toBeUndefined();

    const bySlug = await appsRepository.findBySlug(created.slug);
    expect(bySlug?.id).toBe(created.id);

    const byApiKey = await appsRepository.findByApiKeyId(apiKeyId);
    expect(byApiKey?.id).toBe(created.id);
  });

  test("reads for non-existent identifiers return undefined", async () => {
    expect(pgliteReady).toBe(true);
    expect(await appsRepository.findById(FRESH_UUID)).toBeUndefined();
    // Malformed (non-UUID) id short-circuits to undefined before hitting the DB.
    expect(await appsRepository.findById("not-a-uuid")).toBeUndefined();
    expect(await appsRepository.findBySlug(uniq("missing-slug"))).toBeUndefined();
    expect(await appsRepository.findByApiKeyId(FRESH_UUID)).toBeUndefined();
  });
});

describe("AppsRepository.update", () => {
  test("update returns the merged App and a fresh read reflects the change", async () => {
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
    expect(await appsRepository.update(FRESH_UUID, { name: "ghost" })).toBeUndefined();
  });

  test("update evicts the service read-cache (fresh read returns NEW value, not stale)", async () => {
    expect(pgliteReady).toBe(true);
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

  test("update prevents an older in-flight hydration from republishing stale state", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "Before Concurrent Update",
      organization_id: organizationId,
      created_by_user_id: userId,
    });
    await appsService.invalidateCache(
      created.id,
      created.api_key_id ?? undefined,
      created.slug ?? undefined,
    );

    const originalFindById = appsRepository.findById.bind(appsRepository);
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readRelease = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    appsRepository.findById = async (id: string): Promise<App | undefined> => {
      const captured = await originalFindById(id);
      signalReadStarted?.();
      await readRelease;
      return captured;
    };

    const background: Promise<unknown>[] = [];
    try {
      expect(
        await appsService.getByIdCacheOnly(created.id, {
          executionCtx: { waitUntil: (promise) => background.push(promise) },
        }),
      ).toEqual({ kind: "warming", cacheRead: "miss" });
      expect(background).toHaveLength(1);
      await readStarted;

      await appsRepository.update(created.id, { name: "After Concurrent Update" });
      releaseRead?.();
      await background[0];

      expect(await cache.get<App>(CacheKeys.app.byId(created.id))).toBeNull();
    } finally {
      releaseRead?.();
      appsRepository.findById = originalFindById;
    }

    expect((await appsService.getById(created.id))?.name).toBe("After Concurrent Update");
  });
});

describe("AppsRepository.claimDeploymentStart", () => {
  test("admits one active generation and allows a new generation after failure", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "Single Flight Deploy",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    const firstStartedAt = new Date("2026-08-20T12:00:00.000Z");
    const firstGeneration = "11111111-1111-4111-8111-111111111111";
    const [left, right] = await Promise.all([
      appsRepository.claimDeploymentStart(created.id, firstGeneration, {
        last_deployed_at: firstStartedAt,
        metadata: created.metadata,
      }),
      appsRepository.claimDeploymentStart(created.id, firstGeneration, {
        last_deployed_at: firstStartedAt,
        metadata: created.metadata,
      }),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    expect((left ?? right)?.deployment_status).toBe("building");
    expect((left ?? right)?.metadata.deploymentGeneration).toBe(firstGeneration);

    const staleFailure = await appsRepository.updateDeploymentGeneration(
      created.id,
      "22222222-2222-4222-8222-222222222222",
      { deployment_status: "failed" },
    );
    expect(staleFailure).toBeUndefined();

    await appsRepository.updateDeploymentGeneration(created.id, firstGeneration, {
      deployment_status: "failed",
    });
    const nextStartedAt = new Date("2026-08-20T12:01:00.000Z");
    const nextGeneration = "33333333-3333-4333-8333-333333333333";
    const next = await appsRepository.claimDeploymentStart(created.id, nextGeneration, {
      last_deployed_at: nextStartedAt,
      metadata: (left ?? right)?.metadata,
    });
    expect(next?.deployment_status).toBe("building");
    expect(next?.metadata.deploymentGeneration).toBe(nextGeneration);
    expect(next?.last_deployed_at?.toISOString()).toBe(nextStartedAt.toISOString());

    const deploying = await appsRepository.updateDeploymentGeneration(
      created.id,
      nextGeneration,
      { deployment_status: "deploying", metadata: { containerId: "container-1" } },
      ["building"],
    );
    expect(deploying?.metadata).toMatchObject({
      deploymentGeneration: nextGeneration,
      containerId: "container-1",
    });
    expect(await appsRepository.isDeploymentGenerationCurrent(created.id, nextGeneration)).toBe(
      true,
    );
    await appsRepository.updateDeploymentGeneration(
      created.id,
      nextGeneration,
      { deployment_status: "failed" },
      ["deploying"],
    );
    expect(await appsRepository.isDeploymentGenerationCurrent(created.id, nextGeneration)).toBe(
      false,
    );
    await expect(
      appsRepository.updateDeploymentGeneration(
        created.id,
        nextGeneration,
        { deployment_status: "deploying" },
        ["building"],
      ),
    ).resolves.toBeUndefined();
  });
});

describe("AppsRepository staged deletion", () => {
  test("repository direct update refuses deactivation without credential revocation", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "Direct Deactivate Guard",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    await expect(appsRepository.update(created.id, { is_active: false })).rejects.toThrow(
      "deactivation must use updateWithMobileAuthRevocation",
    );
    await expect(appsRepository.prepareDeleteWithMobileAuthRevocation(FRESH_UUID)).resolves.toEqual(
      {
        app: undefined,
        revokedKeyHashes: [],
      },
    );
    await expect(appsRepository.finalizeDelete(FRESH_UUID)).resolves.toBeUndefined();
  });

  test("revocation tombstone then finalization removes the row and evicts the cache", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const created = await createApp({
      name: "To Delete",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    // Warm cache via the service so we can prove the delete evicts it.
    await appsService.getById(created.id);

    await expect(appsRepository.finalizeDelete(created.id)).rejects.toThrow(
      "requires completed mobile credential revocation",
    );
    await appsRepository.prepareDeleteWithMobileAuthRevocation(created.id);
    await appsRepository.finalizeDelete(created.id);

    expect(await appsRepository.findById(created.id)).toBeUndefined();
    // Service read goes back to the DB (cache evicted) and finds nothing.
    expect(await appsService.getById(created.id)).toBeUndefined();
  });

  test("service deletion uses the primary tombstone row when the read replica misses", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const generated = apiKeysService.generateApiKey();
    const apiKeyId = crypto.randomUUID();
    await apiKeysRepository.create({
      id: apiKeyId,
      name: "Replica-lag app key",
      key_hash: generated.hash,
      key_prefix: generated.prefix,
      organization_id: organizationId,
      user_id: userId,
      is_active: true,
    });
    const created = await createApp({
      name: "Replica Lag Delete",
      organization_id: organizationId,
      created_by_user_id: userId,
      api_key_id: apiKeyId,
    });
    const now = new Date();
    const deployment: AppFrontendDeployment = {
      id: crypto.randomUUID(),
      app_id: created.id,
      version: 1,
      status: "active",
      r2_prefix: `apps/${created.id}/v1/`,
      manifest: null,
      content_hash: null,
      file_count: 0,
      total_bytes: 0,
      build_meta: {},
      error: null,
      created_by_user_id: userId,
      created_at: now,
      updated_at: now,
      finalized_at: now,
      activated_at: now,
    };
    const { userDatabaseService } = await import("../../../lib/services/user-database");
    const { appFrontendDeploymentsRepository } = await import("../app-frontend-deployments");
    const { appFrontendHostingService } = await import(
      "../../../lib/services/app-frontend-hosting"
    );
    const events: string[] = [];
    const originalPrepare = appsRepository.prepareDeleteWithMobileAuthRevocation;
    const originalFinalize = appsRepository.finalizeDelete;
    const originalDeleteKey = apiKeysService.delete;
    const replicaRead = spyOn(appsRepository, "findById").mockResolvedValue(undefined);
    const prepare = spyOn(
      appsRepository,
      "prepareDeleteWithMobileAuthRevocation",
    ).mockImplementation(async (id, deletedAt) => {
      events.push("prepare-primary");
      return await originalPrepare.call(appsRepository, id, deletedAt);
    });
    const cleanupDatabase = spyOn(userDatabaseService, "cleanupDatabase").mockImplementation(
      async () => {
        events.push("cleanup-database");
      },
    );
    const listDeployments = spyOn(appFrontendDeploymentsRepository, "listByApp").mockImplementation(
      async () => {
        events.push("list-deployments");
        return [deployment];
      },
    );
    const deleteArtifacts = spyOn(appFrontendHostingService, "deleteArtifacts").mockImplementation(
      async () => {
        events.push("delete-artifacts");
      },
    );
    const deleteKey = spyOn(apiKeysService, "delete").mockImplementation(async (id) => {
      events.push("delete-ordinary-key");
      await originalDeleteKey.call(apiKeysService, id);
    });
    const finalize = spyOn(appsRepository, "finalizeDelete").mockImplementation(async (id) => {
      events.push("finalize-primary");
      return await originalFinalize.call(appsRepository, id);
    });

    try {
      await appsService.delete(created.id);
      expect(replicaRead).not.toHaveBeenCalled();
      expect(cleanupDatabase).toHaveBeenCalledWith(created.id, {
        organizationId,
        userId,
      });
      expect(listDeployments).toHaveBeenCalledWith(created.id, 1000);
      expect(deleteArtifacts).toHaveBeenCalledWith(deployment);
      expect(deleteKey).toHaveBeenCalledWith(apiKeyId);
      expect(events).toEqual([
        "prepare-primary",
        "cleanup-database",
        "list-deployments",
        "delete-artifacts",
        "delete-ordinary-key",
        "finalize-primary",
      ]);
    } finally {
      finalize.mockRestore();
      deleteKey.mockRestore();
      deleteArtifacts.mockRestore();
      listDeployments.mockRestore();
      cleanupDatabase.mockRestore();
      prepare.mockRestore();
      replicaRead.mockRestore();
    }

    expect(await appsRepository.findById(created.id)).toBeUndefined();
    expect(await apiKeysRepository.findByIdConsistent(apiKeyId)).toBeUndefined();
  });
});

describe("AppsService usage and management wrappers", () => {
  test("usage tracking logs request, app usage, and per-user usage when an API key resolves", async () => {
    expect(pgliteReady).toBe(true);
    const app = {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "usage-wrapper",
    } as App;
    const getByApiKeyId = spyOn(appsService, "getByApiKeyId").mockResolvedValue(app);
    const incrementUsage = spyOn(appsService, "incrementUsage").mockResolvedValue(undefined);
    const trackUsage = spyOn(appsService, "trackUsage").mockResolvedValue(undefined);
    const logRequest = spyOn(appsRepository, "logRequest").mockResolvedValue(undefined as never);

    try {
      await appsService.trackUsageByApiKey("apikey-123456789", "1.25", {
        userId: "22222222-2222-4222-8222-222222222222",
        requestType: "chat",
      });
      await appsService.trackDetailedRequest("apikey-123456789", {
        requestType: "chat",
        source: "ios",
        userId: "22222222-2222-4222-8222-222222222222",
        inputTokens: 10,
        outputTokens: 20,
        creditsUsed: "2.50",
        metadata: { platform: "ios" },
      });

      expect(getByApiKeyId).toHaveBeenCalledTimes(2);
      expect(incrementUsage).toHaveBeenCalledWith(app.id, "1.25");
      expect(incrementUsage).toHaveBeenCalledWith(app.id, "2.50");
      expect(trackUsage).toHaveBeenCalledWith(
        app.id,
        "22222222-2222-4222-8222-222222222222",
        "2.50",
        { requestType: "chat" },
      );
      expect(logRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          app_id: app.id,
          request_type: "chat",
          source: "ios",
          credits_used: "2.50",
        }),
      );
    } finally {
      logRequest.mockRestore();
      trackUsage.mockRestore();
      incrementUsage.mockRestore();
      getByApiKeyId.mockRestore();
    }
  });

  test("page views, analytics wrappers, origins, and API-key regeneration delegate cleanly", async () => {
    expect(pgliteReady).toBe(true);
    const app = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Delegated App",
      slug: "delegated-app",
      app_url: "https://delegated.example",
      allowed_origins: ["https://extra.example"],
      api_key_id: "old-key",
      organization_id: "44444444-4444-4444-8444-444444444444",
      created_by_user_id: "55555555-5555-4555-8555-555555555555",
      is_active: true,
    } as App;
    const logRequest = spyOn(appsRepository, "logRequest").mockResolvedValue(undefined as never);
    const incrementUsage = spyOn(appsService, "incrementUsage").mockResolvedValue(undefined);
    const findById = spyOn(appsRepository, "findById").mockResolvedValue(app);
    const emptyRequestStats = {
      totalRequests: 0,
      uniqueIps: 0,
      uniqueUsers: 0,
      byType: {},
      bySource: {},
      byStatus: {},
      totalCredits: "0",
      avgResponseTime: null,
    };
    const getRequestStats = spyOn(appsRepository, "getRequestStats").mockResolvedValue(
      emptyRequestStats,
    );
    const getRecentRequests = spyOn(appsRepository, "getRecentRequests").mockResolvedValue({
      requests: [],
      total: 0,
    });
    const getTopVisitors = spyOn(appsRepository, "getTopVisitors").mockResolvedValue([] as never);
    const getRequestsOverTime = spyOn(appsRepository, "getRequestsOverTime").mockResolvedValue(
      [] as never,
    );
    const listAppUsers = spyOn(appsRepository, "listAppUsers").mockResolvedValue([] as never);
    const getAnalytics = spyOn(appsRepository, "getAnalytics").mockResolvedValue([]);
    const getTotalStats = spyOn(appsRepository, "getTotalStats").mockResolvedValue({
      totalRequests: 0,
      totalUsers: 0,
      totalCreditsUsed: "0.00",
    });
    const managedDomains = await import("../../../lib/services/managed-domains");
    const listVerifiedOrigins = spyOn(
      managedDomains.managedDomainsService,
      "listVerifiedAppOrigins",
    ).mockResolvedValue(["https://custom.example"]);
    const deleteKey = spyOn(apiKeysService, "delete").mockResolvedValue(undefined);
    const createKey = spyOn(apiKeysService, "create").mockResolvedValue({
      apiKey: { id: "new-key" },
      plainKey: "eliza_new_plain",
    } as never);
    const updateApp = spyOn(appsRepository, "update").mockResolvedValue(app);

    try {
      await appsService.trackPageView(app.id, {
        pageUrl: "https://delegated.example/page",
        referrer: "https://referrer.example",
        source: "ios",
        metadata: { variant: "cloud" },
      });
      expect(logRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          app_id: app.id,
          request_type: "pageview",
          metadata: expect.objectContaining({ variant: "cloud" }),
        }),
      );

      await expect(appsService.getRequestStats(app.id)).resolves.toEqual(emptyRequestStats);
      await expect(appsService.getRecentRequests(app.id)).resolves.toEqual({
        requests: [],
        total: 0,
      });
      await expect(appsService.getTopVisitors(app.id)).resolves.toEqual([]);
      await expect(
        appsService.getRequestsOverTime(app.id, "daily", new Date(), new Date()),
      ).resolves.toEqual([]);
      await expect(appsService.getAppUsers(app.id)).resolves.toEqual([]);
      await expect(
        appsService.getAnalytics(app.id, "daily", new Date(), new Date()),
      ).resolves.toEqual([]);
      await expect(appsService.getTotalStats(app.id)).resolves.toEqual({
        totalRequests: 0,
        totalUsers: 0,
        totalCreditsUsed: "0.00",
      });
      await expect(appsService.getAllowedOrigins(app)).resolves.toEqual([
        "https://delegated.example",
        "https://extra.example",
        "https://custom.example",
      ]);
      await expect(appsService.validateOrigin(app.id, "https://custom.example")).resolves.toBe(
        true,
      );
      await expect(appsService.regenerateApiKey(app.id)).resolves.toBe("eliza_new_plain");
      expect(deleteKey).toHaveBeenCalledWith("old-key");
      expect(createKey).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: app.organization_id,
          user_id: app.created_by_user_id,
        }),
      );
      expect(updateApp).toHaveBeenCalledWith(app.id, { api_key_id: "new-key" });
    } finally {
      updateApp.mockRestore();
      createKey.mockRestore();
      deleteKey.mockRestore();
      listVerifiedOrigins.mockRestore();
      getTotalStats.mockRestore();
      getAnalytics.mockRestore();
      listAppUsers.mockRestore();
      getRequestsOverTime.mockRestore();
      getTopVisitors.mockRestore();
      getRecentRequests.mockRestore();
      getRequestStats.mockRestore();
      findById.mockRestore();
      incrementUsage.mockRestore();
      logRequest.mockRestore();
    }
  });
});

describe("mobile credential app lifecycle", () => {
  async function seedMobileCredential(input: {
    appId: string;
    organizationId: string;
    userId: string;
  }): Promise<{ credentialId: string; keyHash: string; secret: string }> {
    const secret = `eliza_mobile_${crypto.randomUUID().replaceAll("-", "")}${crypto
      .randomUUID()
      .replaceAll("-", "")}`;
    const keyHash = createHash("sha256").update(secret).digest("hex");
    const credentialId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    const provenance = buildMobileAppAuthCredentialProvenance({
      grantId,
      environment: "staging",
      clientId: "ai.elizaos.app",
      scopes: ["cloud:user"],
    });
    await dbWrite.insert(apiKeys).values({
      id: credentialId,
      name: provenance.name,
      description: provenance.description,
      key_hash: keyHash,
      key_prefix: secret.slice(0, 12),
      key_ciphertext: `ciphertext-${credentialId}`,
      key_nonce: `nonce-${credentialId}`,
      key_auth_tag: `auth-tag-${credentialId}`,
      key_kms_key_id: `kms-key-${credentialId}`,
      key_kms_key_version: 7,
      organization_id: input.organizationId,
      user_id: input.userId,
      source_app_id: input.appId,
      is_active: true,
      expires_at: new Date(Date.now() + 60_000),
    });
    await dbWrite.insert(mobileAppAuthGrants).values({
      id: grantId,
      code_hash: createHash("sha256").update(crypto.randomUUID()).digest("hex"),
      app_id: input.appId,
      client_id: "ai.elizaos.app",
      user_id: input.userId,
      organization_id: input.organizationId,
      environment: "staging",
      redirect_uri: "https://eliza.app/auth/callback",
      state_hash: createHash("sha256").update(crypto.randomUUID()).digest("hex"),
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      scopes: ["cloud:user"],
      status: "acknowledged",
      credential_id: credentialId,
      expires_at: new Date(Date.now() + 60_000),
      exchanged_at: new Date(),
      acknowledged_at: new Date(),
    });
    return { credentialId, keyHash, secret };
  }

  async function expectCredentialTombstone(input: {
    appId: string;
    credentialId: string;
    keyHash: string;
  }): Promise<void> {
    const credential = await apiKeysRepository.findById(input.credentialId);
    expect(credential).toMatchObject({
      id: input.credentialId,
      is_active: false,
      key_hash: input.keyHash,
      source_app_id: input.appId,
      key_ciphertext: null,
      key_nonce: null,
      key_auth_tag: null,
      key_kms_key_id: null,
      key_kms_key_version: null,
    });
    expect(credential?.deleted_at).toBeInstanceOf(Date);
  }

  test("deactivation atomically removes grants and revokes the key during cache brownout", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const app = await createApp({
      name: "Mobile Source Deactivate",
      organization_id: organizationId,
      created_by_user_id: userId,
    });
    const credential = await seedMobileCredential({
      appId: app.id,
      organizationId,
      userId,
    });
    expect(await apiKeysService.validateApiKey(credential.secret)).toMatchObject({
      id: credential.credentialId,
    });

    const invalidate = spyOn(apiKeysService, "invalidateCache").mockRejectedValue(
      new Error("configured cache backend is unavailable"),
    );
    let updated: App | undefined;
    try {
      updated = await appsService.update(app.id, { is_active: false });
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      invalidate.mockRestore();
    }
    expect(updated?.is_active).toBe(false);
    expect(await apiKeysService.validateApiKey(credential.secret)).toBeNull();
    expect(
      await dbWrite.query.mobileAppAuthGrants.findFirst({
        where: eq(mobileAppAuthGrants.credential_id, credential.credentialId),
      }),
    ).toBeUndefined();
    await expectCredentialTombstone({
      appId: app.id,
      credentialId: credential.credentialId,
      keyHash: credential.keyHash,
    });
  });

  test("deactivation scrubs stale ciphertext without replacing an existing revocation receipt", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const app = await createApp({
      name: "Mobile Source Existing Tombstone",
      organization_id: organizationId,
      created_by_user_id: userId,
    });
    const credentialId = crypto.randomUUID();
    const secret = `eliza_mobile_${crypto.randomUUID().replaceAll("-", "")}${crypto
      .randomUUID()
      .replaceAll("-", "")}`;
    const keyHash = createHash("sha256").update(secret).digest("hex");
    const originalRevokedAt = new Date("2026-01-02T03:04:05.000Z");
    const provenance = buildMobileAppAuthCredentialProvenance({
      grantId: credentialId,
      environment: "staging",
      clientId: "ai.elizaos.app",
      scopes: ["cloud:user"],
    });
    await dbWrite.insert(apiKeys).values({
      id: credentialId,
      name: provenance.name,
      description: provenance.description,
      key_hash: keyHash,
      key_prefix: secret.slice(0, 12),
      key_ciphertext: `stale-ciphertext-${credentialId}`,
      key_nonce: `stale-nonce-${credentialId}`,
      key_auth_tag: `stale-auth-tag-${credentialId}`,
      key_kms_key_id: `stale-kms-key-${credentialId}`,
      key_kms_key_version: 3,
      organization_id: organizationId,
      user_id: userId,
      source_app_id: app.id,
      is_active: false,
      deleted_at: originalRevokedAt,
      expires_at: new Date(Date.now() + 60_000),
    });

    const mutation = await appsRepository.updateWithMobileAuthRevocation(
      app.id,
      { is_active: false },
      new Date("2026-07-15T12:00:00.000Z"),
    );

    expect(mutation.revokedKeyHashes).toContain(keyHash);
    await expectCredentialTombstone({ appId: app.id, credentialId, keyHash });
    expect((await apiKeysRepository.findById(credentialId))?.deleted_at?.getTime()).toBe(
      originalRevokedAt.getTime(),
    );
  });

  test("deletion keeps durable source attribution and revokes the active key during cache brownout", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const app = await createApp({
      name: "Mobile Source Delete",
      organization_id: organizationId,
      created_by_user_id: userId,
    });
    const credential = await seedMobileCredential({
      appId: app.id,
      organizationId,
      userId,
    });
    expect(await apiKeysService.validateApiKey(credential.secret)).toBeDefined();

    const invalidate = spyOn(apiKeysService, "invalidateCache").mockRejectedValue(
      new Error("configured cache backend is unavailable"),
    );
    try {
      await appsService.delete(app.id);
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      invalidate.mockRestore();
    }

    expect(await appsRepository.findById(app.id)).toBeUndefined();
    expect(await apiKeysService.validateApiKey(credential.secret)).toBeNull();
    await expectCredentialTombstone({
      appId: app.id,
      credentialId: credential.credentialId,
      keyHash: credential.keyHash,
    });
  });
});

describe("AppsRepository.listByOrganization", () => {
  test("returns only that org's apps, ordered updated_at DESC, respecting limit/offset", async () => {
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
    const result = await appsRepository.checkNameAvailability(uniq("Totally Fresh Name"));
    expect(result.available).toBe(true);
    expect(result.conflictType).toBeUndefined();
    expect(result.slug).toBeTruthy();
  });

  test("taken (app slug) -> available:false + slug + conflictType 'app'", async () => {
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
    const result = await appsService.isNameAvailable(uniq("Service Fresh Name"));
    expect(result.available).toBe(true);
    expect(result.suggestedName).toBeUndefined();
  });
});

describe("AppsService.create organization cap", () => {
  test("uses the default cap only when the environment variable is unset", () => {
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    try {
      expect(getMaxAppsPerOrg()).toBe(25);
    } finally {
      if (previousLimit !== undefined) {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });

  test("fails closed on malformed and non-safe configured caps", () => {
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    try {
      for (const value of ["", "0", "-1", "1abc", "9007199254740992"]) {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = value;
        expect(() => getMaxAppsPerOrg()).toThrow(
          "ELIZA_CLOUD_MAX_APPS_PER_ORG must be a positive safe integer",
        );
      }
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
      } else {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });

  test("rejects create on a malformed cap instead of falling back to the default", async () => {
    expect(pgliteReady).toBe(true);
    const previousLimit = process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
    process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = "1abc";
    try {
      const { organizationId, userId } = await seedOrgAndUser();
      await createApp({
        name: "Existing App",
        organization_id: organizationId,
        created_by_user_id: userId,
      });

      await expect(
        appsService.create({
          name: "Rejected Invalid Cap",
          organization_id: organizationId,
          created_by_user_id: userId,
          app_url: "https://invalid-cap.example",
        }),
      ).rejects.toMatchObject({
        name: "ElizaError",
        code: "INVALID_MAX_APPS_PER_ORG",
      });

      expect(await appsRepository.countByOrganization(organizationId)).toBe(1);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG;
      } else {
        process.env.ELIZA_CLOUD_MAX_APPS_PER_ORG = previousLimit;
      }
    }
  });

  test("rejects before API key creation when the org is already at the configured app cap", async () => {
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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
    expect(pgliteReady).toBe(true);
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

describe("AppAnalyticsService session analytics from app_requests", () => {
  test("groups real pageview rows into sessions and ordered funnel steps", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const app = await createApp({
      name: "Session Analytics App",
      organization_id: organizationId,
      created_by_user_id: userId,
    });

    await appsRepository.logRequest({
      app_id: app.id,
      request_type: "pageview",
      source: "hosted_frontend",
      ip_address: "203.0.113.10",
      user_agent: "test-agent",
      input_tokens: 0,
      output_tokens: 0,
      credits_used: "0.00",
      status: "success",
      metadata: {
        visitor_id: "visitor-real-a",
        session_id: "session-real-a",
        page_url: "/",
      },
      created_at: new Date("2026-07-02T12:00:00.000Z"),
    });
    await appsRepository.logRequest({
      app_id: app.id,
      request_type: "pageview",
      source: "hosted_frontend",
      ip_address: "203.0.113.10",
      user_agent: "test-agent",
      input_tokens: 0,
      output_tokens: 0,
      credits_used: "0.00",
      status: "success",
      metadata: {
        visitor_id: "visitor-real-a",
        session_id: "session-real-a",
        page_url: "/checkout",
      },
      created_at: new Date("2026-07-02T12:03:00.000Z"),
    });
    await appsRepository.logRequest({
      app_id: app.id,
      request_type: "pageview",
      source: "hosted_frontend",
      ip_address: "203.0.113.11",
      user_agent: "test-agent",
      input_tokens: 0,
      output_tokens: 0,
      credits_used: "0.00",
      status: "success",
      metadata: {
        visitor_id: "visitor-real-b",
        session_id: "session-real-b",
        page_url: "/",
      },
      created_at: new Date("2026-07-02T12:01:00.000Z"),
    });

    const analytics = await appAnalyticsService.getSessionAnalytics(app.id, {
      funnelSteps: ["/", "/checkout"],
    });

    expect(analytics.summary.totalSessions).toBe(2);
    expect(analytics.summary.totalPageViews).toBe(3);
    expect(analytics.sessions.map((session) => session.sessionId).sort()).toEqual([
      "session-real-a",
      "session-real-b",
    ]);
    expect(analytics.funnel.steps.map((step) => step.sessions)).toEqual([2, 1]);
    expect(analytics.funnel.steps[1]?.conversionFromStartPercent).toBe(50);
  });
});

describe("AppsRepository request analytics", () => {
  test("reads app identity, request filters, aggregates, and visitors from real rows", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const apiKeyId = crypto.randomUUID();
    const app = await createApp({
      name: "Request Analytics",
      organization_id: organizationId,
      created_by_user_id: userId,
      api_key_id: apiKeyId,
      app_url: "https://request-analytics.example",
      website_url: "https://request-analytics.example/site",
      logo_url: "https://request-analytics.example/logo.png",
      allowed_origins: ["https://request-analytics.example"],
    });

    await expect(appsRepository.findByApiKeyId(apiKeyId)).resolves.toMatchObject({ id: app.id });
    await expect(appsRepository.findActiveApprovedById(app.id)).resolves.toEqual({
      id: app.id,
      name: app.name,
    });
    await expect(appsRepository.findPublicInfoById(app.id)).resolves.toMatchObject({
      id: app.id,
      app_url: "https://request-analytics.example",
      is_active: true,
      is_approved: true,
    });
    await expect(appsRepository.isSlugAvailable(app.slug)).resolves.toBe(false);

    const start = new Date("2026-07-18T00:00:00.000Z");
    const end = new Date("2026-07-19T00:00:00.000Z");
    await appsRepository.logRequest({
      app_id: app.id,
      request_type: "chat",
      source: "ios",
      ip_address: "203.0.113.10",
      user_id: userId,
      credits_used: "1.25",
      response_time_ms: 42,
      status: "success",
      created_at: new Date("2026-07-18T12:00:00.000Z"),
    });
    await appsRepository.logRequest({
      app_id: app.id,
      request_type: "chat",
      source: "ios",
      ip_address: null,
      user_id: null,
      credits_used: "0.75",
      response_time_ms: 20,
      status: "error",
      created_at: new Date("2026-07-18T13:00:00.000Z"),
    });

    await expect(
      appsRepository.getRecentRequests(app.id, {
        requestType: "chat",
        source: "ios",
        startDate: start,
        endDate: end,
      }),
    ).resolves.toMatchObject({ total: 2 });
    await expect(appsRepository.getRequestStats(app.id, start, end)).resolves.toMatchObject({
      totalRequests: 2,
      uniqueIps: 1,
      uniqueUsers: 1,
      byType: { chat: 2 },
      bySource: { ios: 2 },
      byStatus: { success: 1, error: 1 },
    });
    await expect(appsRepository.getTopVisitors(app.id, 2, start, end)).resolves.toEqual([
      expect.objectContaining({ ip: "203.0.113.10", requestCount: 1 }),
      expect.objectContaining({ ip: "unknown", requestCount: 1 }),
    ]);
  });
});

describe("Mobile credential tombstone on app deletion (defect: credentials outliving their app)", () => {
  /**
   * Mobile credentials belong to the END USER who authenticated through the
   * app (`api_keys.organization_id`/`user_id`), NOT the developer org that
   * registered and owns the app (`apps.organization_id`/`created_by_user_id`
   * — captured separately on the credential as `source_app_id`, see
   * `mobile-app-auth.ts`). Those are ordinarily unrelated tenants: deleting
   * the developer's org/user cascades to the `apps` row but does nothing to
   * the end user's own org/user/api_keys rows, since api_keys' only FKs
   * (`organization_id`, `user_id`) point at the END USER's tenant. This
   * fixture seeds the two tenants separately so the tests below delete only
   * the app owner and prove the credential is unaffected by any FK cascade
   * OTHER than the one this PR must guarantee (the tombstone trigger).
   */
  async function seedUsableMobileCredential(): Promise<{
    appOwnerOrgId: string;
    appOwnerUserId: string;
    credentialOrgId: string;
    credentialUserId: string;
    appId: string;
    credentialId: string;
    plainSecret: string;
  }> {
    const { organizationId: appOwnerOrgId, userId: appOwnerUserId } = await seedOrgAndUser();
    const { organizationId: credentialOrgId, userId: credentialUserId } = await seedOrgAndUser();
    const created = await createApp({
      name: "Mobile Credential Owner",
      organization_id: appOwnerOrgId,
      created_by_user_id: appOwnerUserId,
    });
    const generated = apiKeysService.generateMobileApiKey();
    const credentialId = crypto.randomUUID();
    await apiKeysRepository.create({
      id: credentialId,
      name: "Mobile credential",
      key_hash: generated.hash,
      key_prefix: generated.prefix,
      organization_id: credentialOrgId,
      user_id: credentialUserId,
      is_active: true,
      source_app_id: created.id,
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });

    // Prove the credential is live BEFORE deletion by driving the real
    // authentication entry point, not a row inspection.
    const preDelete = await apiKeysService.validateApiKey(generated.key);
    expect(preDelete?.id).toBe(credentialId);

    return {
      appOwnerOrgId,
      appOwnerUserId,
      credentialOrgId,
      credentialUserId,
      appId: created.id,
      credentialId,
      plainSecret: generated.key,
    };
  }

  test("app owner organization deletion cascade-deletes the app; the credential (a different tenant) can no longer authenticate", async () => {
    expect(pgliteReady).toBe(true);
    const { appOwnerOrgId, plainSecret } = await seedUsableMobileCredential();

    // The organization-deletion path is a raw repository delete that relies
    // entirely on ON DELETE CASCADE — it never calls
    // AppsService.delete()/prepareDeleteWithMobileAuthRevocation(). The
    // credential's own organization_id/user_id point at an UNRELATED tenant
    // (the end user), so api_keys' own cascades never touch this row —
    // without the 0279 trigger this leaves it active and orphaned forever.
    await organizationsRepository.delete(appOwnerOrgId);

    expect(await apiKeysService.validateApiKey(plainSecret)).toBeNull();
  });

  test("app owner user deletion cascade-deletes the app; the credential (a different tenant) can no longer authenticate", async () => {
    expect(pgliteReady).toBe(true);
    const { appOwnerUserId, plainSecret } = await seedUsableMobileCredential();

    // Same fail-open shape as the organization path: apps.created_by_user_id
    // also cascades on user deletion, bypassing the app-level revocation
    // flow, and again never touches the credential's own (different) tenant.
    await usersRepository.delete(appOwnerUserId);

    expect(await apiKeysService.validateApiKey(plainSecret)).toBeNull();
  });
});
