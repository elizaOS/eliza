import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { disconnectRedis, getRedis } from "../client.js";
import {
  type CachedPolicy,
  getCachedPolicies,
  invalidateCache,
  invalidateTenantCache,
  setCachedPolicies,
} from "../policy-cache.js";

const runRedis = process.env.STEWARD_REDIS_TESTS === "1";
const describeRedis = runRedis ? describe : describe.skip;

const TEST_AGENT = `test-agent-${Date.now()}`;
const TEST_TENANT = `test-tenant-${Date.now()}`;

const SAMPLE_POLICIES: CachedPolicy[] = [
  {
    id: "policy-1",
    type: "api_access",
    name: "openai-access",
    enabled: true,
    priority: 0,
    definition: {
      allow: [{ host: "api.openai.com", paths: ["/v1/*"], methods: ["POST"] }],
    },
  },
  {
    id: "policy-2",
    type: "spend_limit",
    name: "daily-budget",
    enabled: true,
    priority: 1,
    definition: {
      limits: [{ period: "day", max_usd: 50 }],
      on_exceed: "deny",
    },
  },
];

beforeEach(async () => {
  if (!runRedis) return;
  const redis = getRedis();
  await redis.del(`policies:${TEST_TENANT}:${TEST_AGENT}`);
});

afterAll(async () => {
  if (!runRedis) return;
  await disconnectRedis();
});

describeRedis("Policy Cache", () => {
  test("returns null on cache miss", async () => {
    const result = await getCachedPolicies("nonexistent-agent", "nonexistent-tenant");
    expect(result).toBeNull();
  });

  test("set and get policies", async () => {
    await setCachedPolicies(TEST_AGENT, TEST_TENANT, SAMPLE_POLICIES);

    const cached = await getCachedPolicies(TEST_AGENT, TEST_TENANT);
    expect(cached).not.toBeNull();
    expect(cached?.length).toBe(2);
    expect(cached?.[0]?.type).toBe("api_access");
    expect(cached?.[1]?.name).toBe("daily-budget");
  });

  test("invalidate specific agent cache", async () => {
    await setCachedPolicies(TEST_AGENT, TEST_TENANT, SAMPLE_POLICIES);

    // Verify it's there
    expect(await getCachedPolicies(TEST_AGENT, TEST_TENANT)).not.toBeNull();

    // Invalidate
    await invalidateCache(TEST_AGENT, TEST_TENANT);

    // Should be gone
    expect(await getCachedPolicies(TEST_AGENT, TEST_TENANT)).toBeNull();
  });

  test("invalidate without tenant scans all tenants", async () => {
    const tenant2 = `${TEST_TENANT}-2`;

    await setCachedPolicies(TEST_AGENT, TEST_TENANT, SAMPLE_POLICIES);
    await setCachedPolicies(TEST_AGENT, tenant2, SAMPLE_POLICIES);

    // Both should exist
    expect(await getCachedPolicies(TEST_AGENT, TEST_TENANT)).not.toBeNull();
    expect(await getCachedPolicies(TEST_AGENT, tenant2)).not.toBeNull();

    // Invalidate all for this agent
    await invalidateCache(TEST_AGENT);

    // Both should be gone
    expect(await getCachedPolicies(TEST_AGENT, TEST_TENANT)).toBeNull();
    expect(await getCachedPolicies(TEST_AGENT, tenant2)).toBeNull();
  });

  test("TTL expiry", async () => {
    // Set with 1 second TTL
    await setCachedPolicies(TEST_AGENT, TEST_TENANT, SAMPLE_POLICIES, 1);

    // Should be there immediately
    expect(await getCachedPolicies(TEST_AGENT, TEST_TENANT)).not.toBeNull();

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 1500));

    // Should be gone
    expect(await getCachedPolicies(TEST_AGENT, TEST_TENANT)).toBeNull();
  });

  test("invalidateTenantCache clears all agent caches for tenant", async () => {
    const agent2 = `${TEST_AGENT}-2`;

    await setCachedPolicies(TEST_AGENT, TEST_TENANT, SAMPLE_POLICIES);
    await setCachedPolicies(agent2, TEST_TENANT, SAMPLE_POLICIES);

    await invalidateTenantCache(TEST_TENANT);

    expect(await getCachedPolicies(TEST_AGENT, TEST_TENANT)).toBeNull();
    expect(await getCachedPolicies(agent2, TEST_TENANT)).toBeNull();
  });

  test("handles corrupted cache gracefully", async () => {
    const redis = getRedis();
    const key = `policies:${TEST_TENANT}:${TEST_AGENT}`;

    // Write garbage
    await redis.set(key, "not valid json{{{");

    // Should return null (cache miss) and clean up
    const result = await getCachedPolicies(TEST_AGENT, TEST_TENANT);
    expect(result).toBeNull();

    // Key should be deleted
    const exists = await redis.exists(key);
    expect(exists).toBe(0);
  });
});
