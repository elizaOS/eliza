/**
 * The runtime cache registry must not silently drop cross-instance invalidation
 * work while the runtime factory is unloaded. A fresh isolate that never imported
 * the factory still serves character writes, and another instance may already
 * have written the shared `edge:runtime:warm:<agentId>` entry, so the unloaded
 * agent branch must clear that shared entry itself; the organization branch
 * stays a no-op because organization eviction is in-memory only.
 *
 * Deterministic cold-isolate harness: only the registry, the edge cache, and
 * the MOCK_REDIS in-memory cache backend are imported — the runtime factory is
 * never loaded, matching production before the first runtime request.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.MOCK_REDIS = "1";

type RegistryModule = typeof import("./runtime-cache-registry");
type EdgeCacheModule = typeof import("../cache/edge-runtime-cache");
type ClientModule = typeof import("../cache/client");

let registry: RegistryModule;
let edgeRuntimeCache: EdgeCacheModule["edgeRuntimeCache"];
let cache: ClientModule["cache"];

beforeAll(async () => {
  registry = await import("./runtime-cache-registry");
  edgeRuntimeCache = (await import("../cache/edge-runtime-cache")).edgeRuntimeCache;
  cache = (await import("../cache/client")).cache;
});

beforeEach(() => {
  registry._testing.resetActionsForTest();
});

async function seedSharedWarmEntry(
  agentId: string,
  state: { isWarm: boolean; embeddingDimension: number; characterName?: string },
): Promise<void> {
  await edgeRuntimeCache.markRuntimeWarm(agentId, state);
}

describe("invalidateRuntimeFromRegistry with the runtime factory unloaded", () => {
  test("clears the shared warm entry another instance wrote and reports no in-memory eviction", async () => {
    const agentId = randomUUID();
    await seedSharedWarmEntry(agentId, {
      isWarm: true,
      embeddingDimension: 1536,
      characterName: "probe",
    });
    const warmKey = `edge:runtime:warm:${agentId}`;
    expect(await cache.get<Record<string, unknown>>(warmKey)).toMatchObject({ isWarm: true });

    const outcome = await registry.invalidateRuntimeFromRegistry(agentId);

    expect(outcome).toBe(false);
    const after = await cache.get<{ isWarm: boolean }>(warmKey);
    expect(after?.isWarm).toBe(false);
  });

  test("works when no shared entry exists yet", async () => {
    const outcome = await registry.invalidateRuntimeFromRegistry(randomUUID());
    expect(outcome).toBe(false);
  });
});

describe("invalidateOrganizationRuntimesFromRegistry with the runtime factory unloaded", () => {
  test("stays a no-op because organization eviction is in-memory only", async () => {
    const outcome = await registry.invalidateOrganizationRuntimesFromRegistry(randomUUID());
    expect(outcome).toBe(0);
  });
});

describe("registered actions keep owning invalidation", () => {
  test("delegates instead of taking the unloaded branch", async () => {
    const delegated: string[] = [];
    registry.registerRuntimeCacheActions({
      invalidateRuntime: async (agentId) => {
        delegated.push(agentId);
        return true;
      },
      invalidateByOrganization: async () => 0,
    });

    const agentId = randomUUID();
    const outcome = await registry.invalidateRuntimeFromRegistry(agentId);

    expect(outcome).toBe(true);
    expect(delegated).toEqual([agentId]);
  });
});
