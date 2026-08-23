/**
 * Proves the managed-launch credential rotation shares its caller's
 * transaction, against real PGlite DDL and real `api_keys` rows.
 *
 * `prepareManagedLaunchEnvironment` opens a write transaction, takes the agent
 * lifecycle lock, and rotates the sandbox-scoped cloud key inside it. The
 * revoke and the mint used to run on the GLOBAL write pool instead, which made
 * every launch hold one connection while requesting a second. Cloud runs on
 * Workers, where that pool is sized `max: 1`, so the request waited on itself
 * and died at `connectionTimeoutMillis` (30s) — and the rotation also committed
 * independently of the environment write.
 *
 * This harness reproduces the first half exactly rather than by analogy: PGlite
 * here likewise serves a single connection, so unpatched code deadlocks the
 * same way, for the same reason, at the same point.
 *
 * The rollback case below is the load-bearing one: it can only pass when the
 * DELETE and INSERT run on the caller's connection. A rotation issued on a
 * second connection commits on its own, so the previous key would be gone and
 * a replacement stranded no matter how the launch transaction ends.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentNodeIncarnationHistories } from "../../db/schemas/agent-node-incarnation-histories";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { apiKeysService } from "./api-keys";
import { ElizaSandboxService } from "./eliza-sandbox";

const PGLITE_TIMEOUT = 60_000;
const AGENT_ID = "00000000-0000-4000-8000-00000000f001";
const PRIOR_PLAINTEXT_KEY = "eliza_the_key_the_agent_is_running_with";

let pgliteReady = true;
let schemaFailure = "";
let seq = 0;

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function agentKeyName(agentId: string): string {
  return `agent-sandbox:${agentId}`;
}

function hashOf(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/**
 * A launch-ready agent plus the sandbox-scoped key it is currently booting
 * with. The key row is written directly (not through the service) so the test
 * owns its exact hash and can assert identity, not just row counts.
 */
async function seedLaunchableAgent(): Promise<{ organizationId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Managed Launch Org", slug: uniq("managed-launch-org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("managed-launch-user"), organization_id: org.id })
    .returning();
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: org.id,
    user_id: user.id,
    agent_name: "Managed Launch Agent",
    status: "running",
    sandbox_id: "managed-launch-sandbox",
    node_id: "managed-launch-node",
    container_name: "managed-launch-container",
    environment_vars: { ELIZAOS_CLOUD_API_KEY: PRIOR_PLAINTEXT_KEY },
  });
  await dbWrite.insert(apiKeys).values({
    name: agentKeyName(AGENT_ID),
    organization_id: org.id,
    user_id: user.id,
    key_hash: hashOf(PRIOR_PLAINTEXT_KEY),
    key_prefix: PRIOR_PLAINTEXT_KEY.substring(0, 12),
    is_active: true,
  });
  return { organizationId: org.id, userId: user.id };
}

async function agentKeyRows() {
  return await dbWrite
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.name, agentKeyName(AGENT_ID)));
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        apiKeys,
        agentNodeIncarnationHistories,
        dockerNodes,
        agentSandboxes,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    // error-policy:J4 — an unavailable PGlite makes the suite fail visibly in
    // beforeEach rather than silently pass with no database.
    schemaFailure = error instanceof Error ? error.message : String(error);
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(apiKeys);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

/**
 * Deterministic cache for the tests below. The ambient adapter is
 * environment-dependent (CI processes may initialize the cache singleton
 * disabled, silently no-opping `set`), which made the brownout regression fail
 * to establish its own precondition in CI. A Map-backed spy set keeps the
 * exact get/set/delConfirmed semantics while being process-independent.
 */
function installDeterministicCache() {
  const store = new Map<string, unknown>();
  const spies = [
    spyOn(cache, "get").mockImplementation((async (key: string) =>
      store.has(key) ? store.get(key) : null) as never),
    spyOn(cache, "set").mockImplementation((async (key: string, value: unknown) => {
      store.set(key, value);
      return true;
    }) as never),
    spyOn(cache, "delConfirmed").mockImplementation((async (key: string) => {
      store.delete(key);
      return true;
    }) as never),
  ];
  return {
    store,
    brownout() {
      // Deletions stop confirming AND stop landing — entries survive.
      spies[2].mockImplementation((async (_key: string) => false) as never);
    },
    heal() {
      spies[2].mockImplementation((async (key: string) => {
        store.delete(key);
        return true;
      }) as never);
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe("managed launch credential rotation is atomic with its environment write", () => {
  test("a committed launch swaps the sandbox key and stores the replacement", async () => {
    const { organizationId, userId } = await seedLaunchableAgent();
    const service = new ElizaSandboxService();

    const result = await service.prepareManagedLaunchEnvironment({
      agentId: AGENT_ID,
      organizationId,
      userId,
    });

    expect(result).toBeDefined();
    const minted = result?.environment.agentApiKey;
    expect(typeof minted).toBe("string");
    expect(minted).not.toBe(PRIOR_PLAINTEXT_KEY);

    // Exactly one live sandbox key, and it is the minted one — the previous
    // row is gone rather than left active alongside its replacement.
    const rows = await agentKeyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashOf(minted as string));
    expect(rows[0].organization_id).toBe(organizationId);

    // The stored environment references the key that actually exists.
    const [stored] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, AGENT_ID));
    expect((stored.environment_vars as Record<string, string>).ELIZAOS_CLOUD_API_KEY).toBe(minted);
  });

  test("losing the ownership CAS rolls the rotation back and leaves the running key intact", async () => {
    const { organizationId, userId } = await seedLaunchableAgent();
    const service = new ElizaSandboxService();
    const [live] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, AGENT_ID));

    // Hand the launch a stale revision so its guarded UPDATE matches no row —
    // the same outcome a concurrent lifecycle owner produces.
    const stale = spyOn(
      service as unknown as {
        getAgentForLifecycleMutation(
          tx: unknown,
          agentId: string,
          orgId: string,
        ): Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue({
      ...(live as unknown as AgentSandbox),
      environment_revision: (live.environment_revision ?? 0) + 41,
    });

    try {
      await expect(
        service.prepareManagedLaunchEnvironment({
          agentId: AGENT_ID,
          organizationId,
          userId,
        }),
      ).resolves.toBeUndefined();
    } finally {
      stale.mockRestore();
    }

    // The rotation unwound with the transaction: the key the agent is booting
    // with survived, and no replacement was stranded. Both assertions fail if
    // the DELETE/INSERT ran on a second pooled connection.
    const rows = await agentKeyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashOf(PRIOR_PLAINTEXT_KEY));

    const [unchanged] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(eq(agentSandboxes.id, AGENT_ID), eq(agentSandboxes.organization_id, organizationId)),
      );
    expect((unchanged.environment_vars as Record<string, string>).ELIZAOS_CLOUD_API_KEY).toBe(
      PRIOR_PLAINTEXT_KEY,
    );
    expect(unchanged.environment_revision).toBe(live.environment_revision);
  });

  test("a credential re-cached between the pre-commit invalidation and COMMIT is cleared after commit", async () => {
    const { organizationId, userId } = await seedLaunchableAgent();
    const service = new ElizaSandboxService();
    const priorHash = hashOf(PRIOR_PLAINTEXT_KEY);
    const validationKey = CacheKeys.apiKey.validation(priorHash.substring(0, 16));
    const iacKey = CacheKeys.inference.authContext(priorHash);
    const [priorRow] = await agentKeyRows();

    // The race, made deterministic. `launchManagedElizaAgent` shuts the
    // container down only AFTER this call returns, so the agent is still
    // authenticating with the prior key throughout. The instant the
    // in-transaction pass clears the entries, one of those requests misses,
    // reads the row that is STILL visible (the DELETE has not committed), and
    // re-caches it positively for the full 600s validation TTL.
    //
    // The reader is simulated rather than issued for real because `dbRead` and
    // `dbWrite` resolve to the SAME pooled connection here, so a genuine
    // concurrent read would block on the open transaction instead of racing
    // it. What it writes is exactly what `validateApiKey` writes on a miss.
    const det = installDeterministicCache();
    const realInvalidate = apiKeysService.invalidateCache.bind(apiKeysService);
    let reCached = false;
    let invalidationPasses = 0;
    const racing = spyOn(apiKeysService, "invalidateCache").mockImplementation(
      async (keyHash: string) => {
        await realInvalidate(keyHash);
        if (reCached) return;
        reCached = true;
        await cache.set(validationKey, priorRow, CacheTTL.apiKey.validation);
        await cache.set(iacKey, { key_hash: priorHash }, CacheTTL.inference.authContext);
      },
    );

    try {
      const result = await service.prepareManagedLaunchEnvironment({
        agentId: AGENT_ID,
        organizationId,
        userId,
      });
      expect(result).toBeDefined();
      expect(reCached).toBe(true);
      invalidationPasses = racing.mock.calls.length;
    } finally {
      racing.mockRestore();
    }

    // The security claim first: the revoked credential must no longer
    // authorize from either cache, nor validate at all.
    expect(await cache.get(validationKey)).toBeFalsy();
    expect(await cache.get(iacKey)).toBeFalsy();
    expect(await apiKeysService.validateApiKey(PRIOR_PLAINTEXT_KEY)).toBeNull();
    // ...and it is the post-commit pass that achieves it: once before COMMIT,
    // once after.
    expect(invalidationPasses).toBeGreaterThanOrEqual(2);
    det.restore();
  });

  test("a hash whose post-commit confirmation failed is carried to the retry and cleared there", async () => {
    const { organizationId, userId } = await seedLaunchableAgent();
    const service = new ElizaSandboxService();
    const priorHash = hashOf(PRIOR_PLAINTEXT_KEY);
    const validationKey = CacheKeys.apiKey.validation(priorHash.substring(0, 16));
    const [priorRow] = await agentKeyRows();

    const det = installDeterministicCache();
    // The dangerous state Stan's trace describes: A's row data sits POSITIVELY
    // cached (a request re-cached it before the rotation committed) …
    await cache.set(validationKey, priorRow, CacheTTL.apiKey.validation);
    expect(await cache.get(validationKey)).toBeTruthy();
    // … and the cache backend browns out exactly when launch #1 tries to
    // confirm the revocation, so nothing can clear it.
    det.brownout();

    await expect(
      service.prepareManagedLaunchEnvironment({ agentId: AGENT_ID, organizationId, userId }),
    ).rejects.toMatchObject({ code: "MANAGED_LAUNCH_REVOCATION_UNCONFIRMED" });

    // The rotation A→B is COMMITTED (the throw is post-commit), A's positive
    // entry survived the brownout, and — the durable carry — A's row is parked
    // inactive rather than deleted, so its hash is not lost.
    const afterFirst = await agentKeyRows();
    const parkedA = afterFirst.find((row) => row.key_hash === priorHash);
    expect(parkedA).toBeDefined();
    expect(parkedA?.is_active).toBe(false);
    expect(afterFirst.some((row) => row.is_active && row.key_hash !== priorHash)).toBe(true);
    expect(await cache.get(validationKey)).toBeTruthy();

    // Retry with the cache healthy. Its revoke re-collects A by name from the
    // inactive row and re-offers the hash for confirmed invalidation.
    det.heal();
    const retried = await service.prepareManagedLaunchEnvironment({
      agentId: AGENT_ID,
      organizationId,
      userId,
    });
    expect(retried).toBeDefined();

    // The invariant under review: the ORIGINAL hash A no longer authorizes.
    expect(await cache.get(validationKey)).toBeFalsy();
    expect(await apiKeysService.validateApiKey(PRIOR_PLAINTEXT_KEY)).toBeNull();

    // And the carriers are reaped: exactly one live row, the retry's mint.
    const finalRows = await agentKeyRows();
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].is_active).toBe(true);
    expect(finalRows[0].key_hash).toBe(hashOf(retried?.environment.agentApiKey as string));
    det.restore();
  });

  test("a delayed purge cannot reap a carrier a NEWER rotation parked but has not confirmed (round-4 P1#2)", async () => {
    const { organizationId, userId } = await seedLaunchableAgent();
    const service = new ElizaSandboxService();
    const det = installDeterministicCache();
    const hashA = hashOf(PRIOR_PLAINTEXT_KEY);

    // T1: a normal launch whose PURGE is captured and deferred — exactly the
    // advisory-lock-released, purge-delayed window from the review trace.
    let purgeArgs: [string, readonly string[]] | undefined;
    const purgeSpy = spyOn(apiKeysService, "purgeConfirmedRevokedAgentKeys").mockImplementation(
      async (agentId: string, hashes: readonly string[]) => {
        purgeArgs = [agentId, [...hashes]];
      },
    );
    const first = await service.prepareManagedLaunchEnvironment({
      agentId: AGENT_ID,
      organizationId,
      userId,
    });
    purgeSpy.mockRestore();
    expect(first).toBeDefined();
    expect(purgeArgs).toBeDefined();
    const hashB = hashOf(first?.environment.agentApiKey as string);

    // T2: a second rotation parks B (and re-parks A, still present since T1's
    // purge never ran) but its confirmation browns out — B is now a carrier.
    det.brownout();
    await expect(
      service.prepareManagedLaunchEnvironment({ agentId: AGENT_ID, organizationId, userId }),
    ).rejects.toMatchObject({ code: "MANAGED_LAUNCH_REVOCATION_UNCONFIRMED" });
    det.heal();

    // T1's DELAYED purge finally fires — scoped to what T1 confirmed.
    const [purgeAgentId, purgeHashes] = purgeArgs as [string, readonly string[]];
    await apiKeysService.purgeConfirmedRevokedAgentKeys(purgeAgentId, purgeHashes);

    // The invariant: B's carrier row SURVIVES T1's purge. A name-wide purge
    // would have deleted it here, and B — possibly still positively cached —
    // could never be reconfirmed by any retry.
    const rows = await agentKeyRows();
    expect(rows.some((row) => row.key_hash === hashB && row.is_active === false)).toBe(true);
    expect(rows.some((row) => row.key_hash === hashA)).toBe(false);

    // And the retry proves it: B is re-collected, confirmed, and cleared.
    const retried = await service.prepareManagedLaunchEnvironment({
      agentId: AGENT_ID,
      organizationId,
      userId,
    });
    expect(retried).toBeDefined();
    const finalRows = await agentKeyRows();
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].key_hash).toBe(hashOf(retried?.environment.agentApiKey as string));
    det.restore();
  });

  test("a revoke that lands before the mint fails unwinds too", async () => {
    const { organizationId, userId } = await seedLaunchableAgent();
    const service = new ElizaSandboxService();
    // Revoke succeeds, minting its replacement does not — the half-done state
    // that previously left an agent with no key at all, because the DELETE had
    // already committed on its own connection.
    const halfRotation = spyOn(apiKeysService, "createForAgent").mockImplementation(
      async (params) => {
        await apiKeysService.revokeForAgent(params.agentSandboxId, params.tx);
        throw new Error("mint rejected");
      },
    );

    try {
      await expect(
        service.prepareManagedLaunchEnvironment({
          agentId: AGENT_ID,
          organizationId,
          userId,
        }),
      ).rejects.toThrow("mint rejected");
    } finally {
      halfRotation.mockRestore();
    }

    // A propagating failure needs no compensating revoke to stay consistent —
    // the transaction already restored the credential the agent is running on.
    const rows = await agentKeyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashOf(PRIOR_PLAINTEXT_KEY));
  });
});
