import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const TIMEOUT = 15000;
const MODEL_CACHE_KEY = CacheKeys.models.openrouterCatalog();

interface CachedCatalog {
  data: Array<{ id: string }>;
  cachedAt: number;
  staleAt: number;
}

function isPlaceholderCredential(value: string | undefined): boolean {
  if (!value) return false;

  return (
    value.includes("your-redis.upstash.io") ||
    value.includes("default:token@your-redis.upstash.io") ||
    value === "token" ||
    value === "unset"
  );
}

function hasRealCredential(value: string | undefined): boolean {
  return Boolean(value?.trim()) && !isPlaceholderCredential(value);
}

function hasUsableOpenRouterConfig(): boolean {
  return hasRealCredential(process.env.OPENROUTER_API_KEY);
}

function hasUsableCronConfig(): boolean {
  return hasRealCredential(process.env.CRON_SECRET);
}

function hasUsableCacheConfig(): boolean {
  if (process.env.CACHE_ENABLED === "false") {
    return false;
  }

  const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
  const restUrl = process.env.KV_REST_API_URL;
  const restToken = process.env.KV_REST_API_TOKEN;

  if (hasRealCredential(redisUrl)) {
    return true;
  }

  return hasRealCredential(restUrl) && hasRealCredential(restToken);
}

const liveRequested = process.env.RUN_LIVE_MODEL_CATALOG_E2E === "1";
const missingLiveRequirements = [
  !hasUsableOpenRouterConfig() && "OPENROUTER_API_KEY",
  !hasUsableCronConfig() && "CRON_SECRET",
  !hasUsableCacheConfig() && "REDIS_URL or KV_REST_API_URL/KV_REST_API_TOKEN",
].filter(Boolean);
const shouldRun = liveRequested && missingLiveRequirements.length === 0;

async function readCachedCatalog(): Promise<CachedCatalog | null> {
  return await cache.get<CachedCatalog>(MODEL_CACHE_KEY);
}

if (!liveRequested) {
  describe("Model catalog live server E2E", () => {
    test("is opt-in through RUN_LIVE_MODEL_CATALOG_E2E=1", () => {
      expect(liveRequested).toBe(false);
    });
  });
} else if (!shouldRun) {
  describe("Model catalog live server E2E", () => {
    test("has required live configuration", () => {
      expect(missingLiveRequirements).toEqual([]);
    });
  });
} else {
  describe("Model catalog live server E2E", () => {
    beforeEach(async () => {
      await cache.del(MODEL_CACHE_KEY);
    });

    afterAll(async () => {
      await cache.del(MODEL_CACHE_KEY);
    });

    test("populates the shared model catalog cache through the live /api/v1/models endpoint", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/models`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);

      const body = await response.json();
      const cached = await readCachedCatalog();

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(cached).not.toBeNull();
      // The API response merges OpenRouter models with supplemental Groq native models,
      // so body.data.length >= cached.data.length. The cache stores only OpenRouter models.
      expect(cached!.data.length).toBeGreaterThan(0);
      expect(body.data.length).toBeGreaterThanOrEqual(cached!.data.length);
      expect(cached?.data[0]?.id).toBe(body.data[0]?.id);
      expect(typeof cached?.cachedAt).toBe("number");
      expect(cached!.staleAt).toBeGreaterThan(cached!.cachedAt);
    });

    test("reuses the existing cache entry across repeated /models and /models/status requests", async () => {
      const firstModelsResponse = await fetch(`${BASE_URL}/api/v1/models`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(firstModelsResponse.status).toBe(200);

      const firstCached = await readCachedCatalog();
      expect(firstCached).not.toBeNull();

      const secondModelsResponse = await fetch(`${BASE_URL}/api/v1/models`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const statusResponse = await fetch(`${BASE_URL}/api/v1/models/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          modelIds: firstCached!.data.slice(0, 2).map((model) => model.id),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(secondModelsResponse.status).toBe(200);
      expect(statusResponse.status).toBe(200);

      const secondCached = await readCachedCatalog();
      const statusBody = await statusResponse.json();

      expect(secondCached).not.toBeNull();
      expect(secondCached?.cachedAt).toBe(firstCached?.cachedAt);
      expect(statusBody.models.every((model: { available: boolean }) => model.available)).toBe(
        true,
      );
    });

    test("refreshes the shared cache via the live cron endpoint", async () => {
      const initialResponse = await fetch(`${BASE_URL}/api/v1/models`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(initialResponse.status).toBe(200);

      const initialCached = await readCachedCatalog();
      expect(initialCached).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const cronResponse = await fetch(`${BASE_URL}/api/v1/cron/refresh-model-catalog`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(cronResponse.status).toBe(200);

      const cronBody = await cronResponse.json();
      const refreshedCached = await readCachedCatalog();

      expect(cronBody.success).toBe(true);
      expect(refreshedCached).not.toBeNull();
      expect(refreshedCached!.cachedAt).toBeGreaterThan(initialCached!.cachedAt);
      expect(refreshedCached!.data.length).toBeGreaterThan(0);
    });
  });
}
