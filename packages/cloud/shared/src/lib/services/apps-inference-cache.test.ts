/**
 * Proves the inference app lookup reads only shared cache on the request
 * promise and moves authoritative app hydration under Worker `waitUntil`.
 */

process.env.CACHE_BACKEND = "memory";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "../../db/repositories/apps";

let appRows = new Map<string, App>();
let appReads = 0;
let cacheFenceGate: Promise<void> | null = null;

mock.module("../../db/repositories/apps", () => ({
  appsRepository: {
    findById: async (id: string) => {
      appReads += 1;
      return appRows.get(id);
    },
  },
  withAppCacheFence: async <T>(_appId: string, operation: (tx: unknown) => Promise<T>) =>
    await operation({}),
  withAppCacheFences: async <T>(
    _identity: { appId?: string; apiKeyId?: string | null; slug?: string | null },
    operation: (tx: unknown) => Promise<T>,
  ) => {
    if (cacheFenceGate) await cacheFenceGate;
    return await operation({});
  },
}));

mock.module("./api-keys", () => ({
  apiKeysService: {},
}));

mock.module("./managed-domains", () => ({
  managedDomainsService: {},
}));

const { cache } = await import("../cache/client");
const { CacheKeys, CacheTTL } = await import("../cache/keys");
const { appsService } = await import("./apps");

let sequence = 0;

function app(overrides: Partial<App> = {}): App {
  const id = `app-${++sequence}`;
  return {
    id,
    name: id,
    slug: id,
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: "https://app.example",
    monetization_enabled: true,
    ...overrides,
  } as App;
}

beforeEach(() => {
  appRows = new Map();
  appReads = 0;
  cacheFenceGate = null;
});

describe("AppsService inference cache-only lookup", () => {
  test("async invalidation clears a stale row repopulated while shared deletion waits", async () => {
    const stale = app({ review_status: "draft" });
    const fresh = { ...stale, review_status: "approved" } as App;
    appRows.set(stale.id, fresh);
    await cache.set(CacheKeys.app.byId(stale.id), stale, CacheTTL.app.byId);
    expect((await appsService.getById(stale.id))?.review_status).toBe("draft");

    let releaseFence = () => {};
    cacheFenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const invalidation = appsService.invalidateCache(stale.id);

    // The first local eviction has happened, but the shared stale row remains
    // readable until the asynchronous fenced delete is allowed to proceed.
    expect((await appsService.getById(stale.id))?.review_status).toBe("draft");
    releaseFence();
    await invalidation;

    expect(await cache.get(CacheKeys.app.byId(stale.id))).toBeFalsy();
    expect((await appsService.getById(stale.id))?.review_status).toBe("approved");
    expect(appReads).toBe(1);
  });

  test("serves a warm monetized app without an authoritative read", async () => {
    const row = app();
    await cache.set(CacheKeys.app.byId(row.id), row, CacheTTL.app.byId);

    expect(
      await appsService.getAuthorizedMonetizedAppForUserCacheOnly(row.id, {
        id: "user-2",
        organization_id: "org-2",
      }),
    ).toEqual({ kind: "ready", app: row });
    expect(appReads).toBe(0);
  });

  test("returns warming on a miss and hydrates under waitUntil", async () => {
    const row = app();
    appRows.set(row.id, row);
    await cache.del(CacheKeys.app.byId(row.id));
    const background: Promise<unknown>[] = [];

    expect(
      await appsService.getByIdCacheOnly(row.id, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toEqual({ kind: "warming", cacheRead: "miss" });
    expect(background).toHaveLength(1);
    await background[0];
    expect(appReads).toBe(1);
    expect(await appsService.getByIdCacheOnly(row.id)).toEqual({
      kind: "ready",
      app: row,
    });
    expect(appReads).toBe(1);
  });

  test("never starts a database read for a cold key without waitUntil", async () => {
    const row = app();
    appRows.set(row.id, row);
    await cache.del(CacheKeys.app.byId(row.id));

    expect(await appsService.getByIdCacheOnly(row.id)).toEqual({
      kind: "warming",
      cacheRead: "miss",
    });
    expect(appReads).toBe(0);
  });

  test("negative-caches a missing app and treats it as a ready non-app", async () => {
    const id = `missing-${++sequence}`;
    await cache.del(CacheKeys.app.byId(id));
    const background: Promise<unknown>[] = [];

    expect(
      await appsService.getByIdCacheOnly(id, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toEqual({ kind: "warming", cacheRead: "miss" });
    await background[0];
    expect(await appsService.getByIdCacheOnly(id)).toEqual({
      kind: "ready",
      app: null,
    });
    expect(appReads).toBe(1);
  });

  test("rejects a mismatched cached app shape instead of authorizing it", async () => {
    const requested = app();
    const wrong = app();
    await cache.set(CacheKeys.app.byId(requested.id), wrong, CacheTTL.app.byId);

    expect(await appsService.getByIdCacheOnly(requested.id)).toEqual({
      kind: "warming",
      cacheRead: "invalid",
    });
    expect(appReads).toBe(0);
  });
});
