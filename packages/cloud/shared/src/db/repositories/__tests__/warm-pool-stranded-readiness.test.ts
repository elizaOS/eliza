/**
 * Proves warm-pool readiness, claim, and crash reconciliation against real
 * Drizzle queries on isolated PGlite, with a live HTTP health endpoint.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.WARM_POOL_ENABLED = "1";

const PGLITE_TIMEOUT = 60_000;
const IMAGE = "ghcr.io/elizaos/eliza:atomic-ready";
const OTHER_IMAGE = "ghcr.io/elizaos/eliza:stale";
const USER_ORG_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests;
let repository: InstanceType<typeof import("../agent-sandboxes").AgentSandboxesRepository>;
let healthServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    throw new Error(
      `warm-pool readiness proof requires isolated PGlite, received ${AMBIENT_DATABASE_URL}`,
    );
  }

  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
  const repositoryModule = await import("../agent-sandboxes");
  repository = new repositoryModule.AgentSandboxesRepository();

  const schema = { organizations, users, userCharacters, agentSandboxes };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  await repository.countAllPoolEntries({ image: IMAGE });

  await dbWrite.insert(organizations).values({
    id: USER_ORG_ID,
    name: "Warm Pool Claim Test",
    slug: "warm-pool-claim-test",
    credit_balance: "0.000000",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    name: "Warm Pool Claim User",
    steward_user_id: "steward:warm-pool-claim-test",
    organization_id: USER_ORG_ID,
  });

  healthServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ status: "ok" }),
  });
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  if (healthServer) await healthServer.stop(true);
  if (closeDb) await closeDb();
});

function healthUrl(): string {
  return `http://127.0.0.1:${healthServer.port}/health`;
}

async function seedPoolEntry(
  overrides: Partial<typeof agentSandboxes.$inferInsert> = {},
): Promise<typeof agentSandboxes.$inferSelect> {
  return repository.createPoolEntry({
    agent_name: `pool-${crypto.randomUUID().slice(0, 8)}`,
    status: "running",
    execution_tier: "dedicated-always",
    database_status: "ready",
    sandbox_id: `sandbox-${crypto.randomUUID()}`,
    node_id: "node-1",
    container_name: `agent-${crypto.randomUUID()}`,
    bridge_url: "http://100.64.0.10:3000",
    health_url: healthUrl(),
    docker_image: IMAGE,
    image_digest: `sha256:${"a".repeat(64)}`,
    pool_ready_at: new Date("2026-07-30T00:00:00.000Z"),
    ...overrides,
  });
}

async function seedUserAgent(): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: USER_ORG_ID,
      user_id: USER_ID,
      agent_name: `claim-${crypto.randomUUID().slice(0, 8)}`,
      status: "pending",
      execution_tier: "dedicated-always",
      database_status: "none",
    })
    .returning({ id: agentSandboxes.id });
  if (!row) throw new Error("failed to seed claim target");
  return row.id;
}

describe("one claimable-capacity predicate", () => {
  test(
    "counts, image inventory, and the claim transaction agree on the exact row",
    async () => {
      const valid = await seedPoolEntry();
      await seedPoolEntry({ pool_ready_at: null });
      await seedPoolEntry({ bridge_url: null });
      await seedPoolEntry({ node_id: null });
      await seedPoolEntry({ container_name: null });
      await seedPoolEntry({ health_url: null });
      await seedPoolEntry({ docker_image: OTHER_IMAGE });
      await seedPoolEntry({
        status: "provisioning",
        pool_ready_at: null,
        sandbox_id: null,
        node_id: null,
        container_name: null,
        bridge_url: null,
        health_url: null,
      });

      expect(await repository.countUnclaimedPool({ image: IMAGE })).toBe(1);
      expect(await repository.countReadyPoolEntriesForImage(IMAGE)).toBe(1);
      expect(await repository.countAllPoolEntries({ image: IMAGE })).toEqual({
        ready: 1,
        provisioning: 1,
      });
      expect((await repository.listClaimablePool({ image: IMAGE })).map((row) => row.id)).toEqual([
        valid.id,
      ]);

      const userAgentId = await seedUserAgent();
      const claimed = await repository.claimWarmContainer({
        userAgentId,
        organizationId: USER_ORG_ID,
        image: IMAGE,
        agentName: "claimed",
      });
      expect(claimed?.warm_pool_row_id).toBe(valid.id);
      expect(claimed?.status).toBe("provisioning");
      expect(await repository.countUnclaimedPool({ image: IMAGE })).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "two concurrent users cannot claim the same ready row",
    async () => {
      const pool = await seedPoolEntry();
      const [firstUserAgentId, secondUserAgentId] = await Promise.all([
        seedUserAgent(),
        seedUserAgent(),
      ]);

      const claims = await Promise.all([
        repository.claimWarmContainer({
          userAgentId: firstUserAgentId,
          organizationId: USER_ORG_ID,
          image: IMAGE,
          agentName: "first",
        }),
        repository.claimWarmContainer({
          userAgentId: secondUserAgentId,
          organizationId: USER_ORG_ID,
          image: IMAGE,
          agentName: "second",
        }),
      ]);

      const winners = claims.filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.warm_pool_row_id).toBe(pool.id);
      expect(await repository.findById(pool.id)).toBeUndefined();
    },
    PGLITE_TIMEOUT,
  );
});

describe("atomic readiness transition", () => {
  test(
    "only one final provision generation can commit running and readiness",
    async () => {
      const provisioning = await seedPoolEntry({
        status: "provisioning",
        pool_ready_at: null,
      });

      const results = await Promise.all([
        repository.commitPoolEntryReady(provisioning),
        repository.commitPoolEntryReady(provisioning),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const stored = await repository.findById(provisioning.id);
      expect(stored?.status).toBe("running");
      expect(stored?.pool_ready_at).toBeInstanceOf(Date);
      expect(await repository.countUnclaimedPool({ image: IMAGE })).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a generation missing a required locator cannot become ready",
    async () => {
      const provisioning = await seedPoolEntry({
        status: "provisioning",
        pool_ready_at: null,
        bridge_url: null,
      });

      expect(await repository.commitPoolEntryReady(provisioning)).toBeUndefined();
      const stored = await repository.findById(provisioning.id);
      expect(stored?.status).toBe("provisioning");
      expect(stored?.pool_ready_at).toBeNull();
    },
    PGLITE_TIMEOUT,
  );
});

describe("production crash reconciliation", () => {
  test(
    "a fresh legacy running generation is not promoted during its restore tail",
    async () => {
      const activeRestore = await seedPoolEntry({
        pool_ready_at: null,
        created_at: new Date(),
      });

      expect(await repository.listWarmPoolReconciliationCandidates(15 * 60 * 1000)).toEqual([]);
      expect((await repository.findById(activeRestore.id))?.pool_ready_at).toBeNull();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "replenish promotes a healthy stranded row even while heartbeat timestamps stay fresh",
    async () => {
      const stranded = await seedPoolEntry({
        pool_ready_at: null,
        created_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      await dbWrite.execute(
        sql`UPDATE ${agentSandboxes}
            SET last_heartbeat_at = NOW(), updated_at = NOW()
            WHERE id = ${stranded.id}`,
      );

      const { HetznerPoolContainerCreator } = await import(
        "../../../lib/services/containers/agent-warm-pool-creator"
      );
      const { WarmPoolManager } = await import("../../../lib/services/containers/agent-warm-pool");
      const manager = new WarmPoolManager(new HetznerPoolContainerCreator());
      const result = await manager.replenish(IMAGE);

      expect(result.reconciliation).toMatchObject({
        scanned: 1,
        probed: 1,
        promoted: [stranded.id],
        reaped: [],
        deferred: [],
        failed: [],
      });
      expect(result.decision.toCreate).toBe(0);
      expect(result.state.readyCount).toBe(1);

      const stored = await repository.findById(stranded.id);
      expect(stored?.status).toBe("running");
      expect(stored?.pool_ready_at).toBeInstanceOf(Date);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a stale probe can either promote or fence a generation, never do both",
    async () => {
      const stranded = await seedPoolEntry({ pool_ready_at: null });
      const [promoted, reserved] = await Promise.all([
        repository.promoteStrandedPoolEntryReady(stranded),
        repository.reserveUnclaimablePoolEntryForReap(stranded, "readiness probe failed"),
      ]);

      expect(Number(Boolean(promoted)) + Number(Boolean(reserved))).toBe(1);
      const stored = await repository.findById(stranded.id);
      if (promoted) {
        expect(stored?.status).toBe("running");
        expect(stored?.pool_ready_at).toBeInstanceOf(Date);
      } else {
        expect(stored?.status).toBe("deletion_failed");
        expect(stored?.pool_ready_at).toBeNull();
      }
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the stale finder does not mistake a heartbeat-refreshed running row for an in-flight provision",
    async () => {
      const stranded = await seedPoolEntry({
        pool_ready_at: null,
        created_at: new Date(Date.now() - 60_000),
      });
      await dbWrite
        .update(agentSandboxes)
        .set({
          updated_at: new Date("2026-07-30T00:00:00.000Z"),
          last_heartbeat_at: new Date("2026-07-30T00:00:00.000Z"),
        })
        .where(eq(agentSandboxes.id, stranded.id));

      const stuck = await repository.findStuckPoolProvisioning(1);
      expect(stuck.map((row) => row.id)).not.toContain(stranded.id);
      expect(
        (await repository.listWarmPoolReconciliationCandidates(1)).map(
          (candidate) => candidate.sandbox.id,
        ),
      ).toContain(stranded.id);
    },
    PGLITE_TIMEOUT,
  );
});
