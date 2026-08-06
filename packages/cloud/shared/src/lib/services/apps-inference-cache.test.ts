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

// `holdFindById` lets a test park an authoritative read mid-flight, which is
// the only way to reproduce an invalidation racing a read already past its
// generation sample.
let holdFindById: Promise<void> | null = null;

mock.module("../../db/repositories/apps", () => ({
  appsRepository: {
    findById: async (id: string) => {
      appReads += 1;
      if (holdFindById) await holdFindById;
      return appRows.get(id);
    },
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
const { evictInferenceAppMemoryCache, inferenceAppMemoryCache } = await import(
  "./inference-app-memory-cache"
);

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
  holdFindById = null;
});

describe("AppsService inference cache-only lookup", () => {
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
  // A mutation invalidates through the repository (`invalidateAppCacheEntries`
  // -> `evictInferenceAppMemoryCache`) while an authoritative read is already
  // awaiting its DB round trip. The read sampled the hydration generation
  // BEFORE the invalidation, so it must notice the bump and decline to publish
  // the row it is holding — otherwise the pre-mutation row lands back in the
  // SHARED cache, where every worker serves it for the full TTL.
  test("an invalidation racing an in-flight read is not undone by that read", async () => {
    const row = app();
    appRows.set(row.id, row);

    let release: () => void = () => {};
    holdFindById = new Promise<void>((resolve) => {
      release = resolve;
    });

    const read = appsService.getById(row.id);
    // Wait until the read is genuinely parked inside `findById`. `appReads`
    // increments before the hold is awaited, and the generation is sampled
    // before that call — so this guarantees the invalidation below lands
    // AFTER the sample, which is the interleaving under test.
    while (appReads === 0) await Promise.resolve();
    evictInferenceAppMemoryCache(row.id);
    release();
    await read;

    expect(inferenceAppMemoryCache.get(row.id)).toBeNull();
    expect((await appsService.getByIdCacheOnly(row.id)).kind).toBe("warming");
  });
});
