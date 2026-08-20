/**
 * Proves a monetization-settings mutation publishes the fresh app row through
 * the shared cache instead of manufacturing a cold cache-only miss, so the
 * Worker's very next inference for the app is admitted rather than answered
 * with a warming 503 (#17007). Repositories are mocked; the cache client,
 * hydration generation fence, and apps/app-credits services are real.
 */

process.env.CACHE_BACKEND = "memory";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "../../db/repositories/apps";

let appRows = new Map<string, App>();
let appReads = 0;
let onFence: ((id: string) => void) | null = null;

mock.module("../../db/repositories/apps", () => ({
  appsRepository: {
    findById: async (id: string) => {
      appReads += 1;
      return appRows.get(id);
    },
    update: async (id: string, changes: Partial<App>) => {
      const row = appRows.get(id);
      if (!row) throw new Error(`no app row ${id}`);
      const updated = { ...row, ...changes };
      appRows.set(id, updated);
      return updated;
    },
  },
  withAppCacheFence: async <T>(appId: string, operation: (tx: unknown) => Promise<T>) => {
    onFence?.(appId);
    return await operation({});
  },
  withAppCacheFences: async <T>(
    _identity: { appId?: string; apiKeyId?: string | null; slug?: string | null },
    operation: (tx: unknown) => Promise<T>,
  ) => await operation({}),
}));

mock.module("../../db/repositories/app-earnings", () => ({
  appEarningsRepository: {
    getOrCreate: async () => ({}),
  },
}));

mock.module("../../db/repositories/organizations", () => ({
  organizationsRepository: {},
}));

mock.module("../../db/repositories/users", () => ({
  usersRepository: {},
}));

mock.module("./credits", () => ({
  APP_CHAT_RESERVATION_SETTLEMENT_MARKER: "app-chat-settlement",
  assertCreditRefundWithinReservation: () => {
    throw new Error("credit refund assertion is outside this test path");
  },
  assertValidCreditSettlementCosts: () => {
    throw new Error("credit settlement assertion is outside this test path");
  },
  creditsService: {},
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
  MIN_RESERVATION: 0.0001,
}));

mock.module("./redeemable-earnings", () => ({
  redeemableEarningsService: {},
}));

mock.module("./api-keys", () => ({
  apiKeysService: {},
}));

mock.module("./managed-domains", () => ({
  managedDomainsService: {},
}));

const { cache } = await import("../cache/client");
const { CacheKeys, CacheTTL } = await import("../cache/keys");
const { invalidateInferenceAppByIdState } = await import("./inference-app-memory-cache");
const { appsService } = await import("./apps");
const { appCreditsService } = await import("./app-credits");

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
    monetization_enabled: false,
    review_status: "approved",
    ...overrides,
  } as App;
}

beforeEach(() => {
  appRows = new Map();
  appReads = 0;
  onFence = null;
});

describe("updateMonetizationSettings cache publication", () => {
  test("writes the updated row through so the next cache-only read is ready", async () => {
    const row = app();
    appRows.set(row.id, row);
    invalidateInferenceAppByIdState(row.id);
    await cache.del(CacheKeys.app.byId(row.id));

    await appCreditsService.updateMonetizationSettings(row.id, {
      monetizationEnabled: true,
    });

    const readsAfterMutation = appReads;
    const resolution = await appsService.getByIdCacheOnly(row.id);
    expect(resolution.kind).toBe("ready");
    if (resolution.kind !== "ready") throw new Error("unreachable");
    expect(resolution.app?.monetization_enabled).toBe(true);
    // The primary row returned by update was published directly. Neither the
    // mutation nor the cache-only read needed a replica/read-intent round-trip.
    expect(readsAfterMutation).toBe(0);
    expect(appReads).toBe(0);

    const monetized = await appsService.getAuthorizedMonetizedAppForUserCacheOnly(row.id, {
      id: "user-2",
      organization_id: "org-2",
    });
    expect(monetized).toEqual({ kind: "ready", app: appRows.get(row.id) ?? null });
  });

  test("evicts derived markup and slug keys on mutation", async () => {
    const row = app({ monetization_enabled: true });
    appRows.set(row.id, row);
    invalidateInferenceAppByIdState(row.id);
    await cache.set(CacheKeys.app.costMarkup(row.id), { stale: true }, CacheTTL.app.byId);
    await cache.set(CacheKeys.app.bySlug(row.slug), row, CacheTTL.app.bySlug);

    await appCreditsService.updateMonetizationSettings(row.id, {
      inferenceMarkupPercentage: 25,
    });

    expect(await cache.get(CacheKeys.app.costMarkup(row.id))).toBeFalsy();
    expect(await cache.get(CacheKeys.app.bySlug(row.slug))).toBeFalsy();
    const published = await cache.get<App>(CacheKeys.app.byId(row.id));
    expect(published?.inference_markup_percentage).toBe(25);
  });

  test("a superseded generation never republishes its stale row", async () => {
    const row = app();
    appRows.set(row.id, row);
    invalidateInferenceAppByIdState(row.id);
    await cache.del(CacheKeys.app.byId(row.id));

    // Interfere after the publisher captured its generation but before it
    // enters the durable cache fence.
    onFence = (id) => {
      if (id === row.id) {
        invalidateInferenceAppByIdState(row.id);
      }
    };

    await appCreditsService.updateMonetizationSettings(row.id, {
      monetizationEnabled: true,
    });

    expect(await cache.get(CacheKeys.app.byId(row.id))).toBeFalsy();
  });
});
