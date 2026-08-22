/**
 * Exercises the Cloud synthetic lease repository on real PGlite transactions,
 * including collision, generation fencing, rollback, and expiry recovery.
 */

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { agentTable } from "../schemas/eliza";
import { syntheticEnvironmentLeases } from "../schemas/synthetic-environment-leases";
import { agentsRepository } from "./agents/agents";
import { CloudSyntheticEnvironmentLeaseStore } from "./synthetic-environment-leases";

const store = new CloudSyntheticEnvironmentLeaseStore();

beforeAll(async () => {
  const { apply } = await pushSchema(
    { agentTable, syntheticEnvironmentLeases } as never,
    dbWrite as never,
  );
  await apply();
}, 60_000);

beforeEach(async () => {
  await dbWrite.delete(agentTable);
  await dbWrite.delete(syntheticEnvironmentLeases);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

function owner(ownerId: string) {
  return { ownerId, processId: process.pid, host: "cloud-test-worker" };
}

describe("CloudSyntheticEnvironmentLeaseStore", () => {
  it("admits one concurrent owner and returns canonical readback", async () => {
    const attempts = await Promise.allSettled([
      store.acquire({
        namespace: "cloud:race",
        owner: owner("worker-a"),
        leaseDurationMs: 5_000,
      }),
      store.acquire({
        namespace: "cloud:race",
        owner: owner("worker-b"),
        leaseDurationMs: 5_000,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "SYNTHETIC_LEASE_COLLISION" },
    });
    expect(await store.read("cloud:race")).toEqual(
      expect.objectContaining({ generation: 1, revision: 1, status: "active" }),
    );
  }, 30_000);

  it("holds the generation lock across a production transaction callback", async () => {
    const committedAgentId = "00000000-0000-4000-8000-000000000101";
    const staleAgentId = "00000000-0000-4000-8000-000000000102";
    const acquired = await store.acquire({
      namespace: "cloud:guarded",
      owner: owner("worker-a"),
      leaseDurationMs: 5_000,
    });
    const heartbeat = await store.heartbeat({
      authority: acquired.authority,
      leaseDurationMs: 5_000,
    });
    expect(heartbeat).toEqual(
      expect.objectContaining({
        operation: "heartbeat",
        snapshot: expect.objectContaining({ revision: 2, status: "active" }),
      }),
    );
    const written = await store.withActiveGeneration(acquired.authority, async (tx) => {
      return agentsRepository.create({ id: committedAgentId, name: "Generation One Agent" }, tx);
    });
    expect(written).toEqual(
      expect.objectContaining({
        value: true,
        receipt: expect.objectContaining({ operation: "guarded-write" }),
      }),
    );

    const rolled = await store.rollover({
      authority: acquired.authority,
      leaseDurationMs: 5_000,
    });
    expect(rolled.authority.generation).toBe(2);
    await expect(
      store.withActiveGeneration(acquired.authority, async (tx) => {
        await agentsRepository.create({ id: staleAgentId, name: "Stale Agent" }, tx);
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });
    expect(
      await dbWrite
        .select({ id: agentTable.id, name: agentTable.name })
        .from(agentTable)
        .where(eq(agentTable.id, committedAgentId)),
    ).toEqual([{ id: committedAgentId, name: "Generation One Agent" }]);
    expect(
      await dbWrite
        .select({ id: agentTable.id })
        .from(agentTable)
        .where(eq(agentTable.id, staleAgentId)),
    ).toEqual([]);

    await expect(
      store.release({
        ...rolled.authority,
        owner: { ...rolled.authority.owner, ownerId: "worker-b" },
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });
    expect((await store.release(rolled.authority)).snapshot.status).toBe("released");
  });

  it("rolls back a guarded write that outlives its lease", async () => {
    const expiredAgentId = "00000000-0000-4000-8000-000000000103";
    const acquired = await store.acquire({
      namespace: "cloud:expiry-write",
      owner: owner("worker-a"),
      leaseDurationMs: 40,
    });
    await expect(
      store.withActiveGeneration(acquired.authority, async (tx) => {
        await agentsRepository.create({ id: expiredAgentId, name: "Expired Agent" }, tx);
        await Bun.sleep(80);
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });
    expect(
      await dbWrite
        .select({ id: agentTable.id })
        .from(agentTable)
        .where(eq(agentTable.id, expiredAgentId)),
    ).toEqual([]);
  });

  it("recovers expiry and advances generations after clean release", async () => {
    const expired = await store.acquire({
      namespace: "cloud:recovery",
      owner: owner("worker-a"),
      leaseDurationMs: 30,
    });
    await Bun.sleep(60);
    const recovered = await store.acquire({
      namespace: "cloud:recovery",
      owner: owner("worker-b"),
      leaseDurationMs: 5_000,
    });
    expect(recovered).toEqual(
      expect.objectContaining({
        operation: "recover",
        authority: expect.objectContaining({ generation: expired.authority.generation + 1 }),
      }),
    );
    await store.release(recovered.authority);
    const reacquired = await store.acquire({
      namespace: "cloud:recovery",
      owner: owner("worker-c"),
      leaseDurationMs: 5_000,
    });
    expect(reacquired).toEqual(
      expect.objectContaining({
        operation: "acquire",
        authority: expect.objectContaining({ generation: recovered.authority.generation + 1 }),
      }),
    );
  });
});
