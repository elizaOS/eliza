/**
 * Exercises the #23100 world-metadata compare-and-swap against the first-party
 * ephemeral adapter: snapshot match/mismatch, value equality with key-order
 * differences, audit-row placement (inserted before the swap so a storage
 * throw leaves the world untouched), and world-not-found. Real adapter over
 * real storage, no mocks.
 */
import { randomUUID } from "node:crypto";

import {
  ROLE_WRITE_AUDIT_LOG_TYPE,
  type UUID,
  WORLD_METADATA_REVISION_KEY,
  type World,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";
import { COLLECTIONS } from "./types";

const AGENT_ID = "70000000-0000-0000-0000-000000000001" as UUID;
const ACTOR_ID = "70000000-0000-0000-0000-000000000002" as UUID;
const TARGET_ID = "70000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = randomUUID() as UUID;
const WORLD_ID = randomUUID() as UUID;

const BASE_METADATA = {
  ownership: { ownerId: String(ACTOR_ID) },
  roles: { [String(ACTOR_ID)]: "OWNER", [String(TARGET_ID)]: "USER" },
};

async function buildAdapter() {
  return buildAdapterOn(new MemoryStorage());
}

async function buildAdapterOn(storage: MemoryStorage) {
  const adapter = new InMemoryDatabaseAdapter(storage, AGENT_ID);
  await adapter.init();
  await adapter.createWorlds([
    {
      id: WORLD_ID,
      agentId: AGENT_ID,
      name: "cas-world",
      // Deep-clone per adapter: the memory store keeps the object by
      // reference, and the live-mutation test below edits a world's
      // metadata in place — a shared module-level fixture would leak that
      // edit into every subsequently built adapter.
      metadata: structuredClone(BASE_METADATA) as unknown as World["metadata"],
    },
  ]);
  return adapter;
}

async function storedMetadata(adapter: InMemoryDatabaseAdapter) {
  const rows = await adapter.getWorldsByIds([WORLD_ID]);
  return (rows[0]?.metadata ?? {}) as Record<string, unknown>;
}

describe("InMemoryDatabaseAdapter.compareAndSwapWorldMetadata", () => {
  it("rejects duplicate create without resetting a CAS-managed world", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    await expect(
      adapter.createWorlds([
        {
          id: WORLD_ID,
          agentId: AGENT_ID,
          name: "replacement",
          metadata: { roles: { [String(TARGET_ID)]: "GUEST" } },
        },
      ])
    ).rejects.toMatchObject({ code: "WORLD_ALREADY_EXISTS" });
    expect(await storedMetadata(adapter)).toEqual(before);
  });
  it("commits when the snapshot matches, updating metadata and audit together", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";

    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: before as never,
      replacementMetadata: replacement as never,
      audit: {
        actorEntityId: ACTOR_ID,
        targetEntityId: TARGET_ID,
        previousRole: "USER",
        newRole: "ADMIN",
        source: "manual",
        roomId: ROOM_ID,
      },
    });

    expect(result).toEqual({ status: "updated" });
    const after = await storedMetadata(adapter);
    expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("ADMIN");
    const logs = await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE });
    expect(logs).toHaveLength(1);
    const body = logs[0]?.body as { source: string; metadata?: Record<string, unknown> };
    expect(body?.source).toBe("role-write-cas");
    expect(body?.metadata?.newRole).toBe("ADMIN");
    expect(body?.metadata?.outcome).toBe("committed");
  });

  it("conflicts when the stored metadata drifted from the snapshot", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    // A concurrent writer lands first.
    const raced = structuredClone(before);
    (raced as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "GUEST";
    const racedResult = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: before as never,
      replacementMetadata: raced as never,
    });
    expect(racedResult).toEqual({ status: "updated" });

    // The stale snapshot must now conflict, not overwrite.
    const stale = structuredClone(before);
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: stale as never,
      replacementMetadata: { ...stale, extra: "y" } as never,
      audit: {
        actorEntityId: ACTOR_ID,
        targetEntityId: TARGET_ID,
        previousRole: "USER",
        newRole: "ADMIN",
        source: "manual",
        roomId: ROOM_ID,
      },
    });
    expect(result).toEqual({ status: "conflict" });
    const after = await storedMetadata(adapter);
    expect(after).not.toHaveProperty("extra");
    expect(await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE })).toHaveLength(0);
  });

  it("treats key order as insignificant (value equality)", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    // Same keys and values, different insertion order: the stored metadata
    // reads back from the store as {ownership, roles}; present the snapshot
    // with the top-level keys in the opposite order. Adding or removing a
    // key must NOT count as reordering — that is a genuine value change and
    // must conflict (covered by the drift test above).
    const reordered = Object.fromEntries(Object.entries(before).reverse());
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: reordered as never,
      replacementMetadata: structuredClone(before) as never,
    });
    expect(result).toEqual({ status: "updated" });
  });

  it("reports not_found for an unknown world", async () => {
    const adapter = await buildAdapter();
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: randomUUID() as UUID,
      expectedMetadata: {} as never,
      replacementMetadata: {} as never,
    });
    expect(result).toEqual({ status: "not_found" });
  });

  it("leaves the world untouched when the audit-row insert throws", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";

    // Storage that rejects every LOGS write: the audit insert rides ahead of
    // the metadata swap, so the throw must leave the stored world unchanged.
    const failingLogsStorage = adapter.storage as unknown as {
      set: (collection: string, id: string, value: unknown) => Promise<void>;
    };
    const originalSet = failingLogsStorage.set.bind(failingLogsStorage);
    failingLogsStorage.set = async (collection, id, value) => {
      if (
        collection === "logs" &&
        (value as { type?: string }).type === ROLE_WRITE_AUDIT_LOG_TYPE
      ) {
        throw new Error("audit storage unavailable");
      }
      return originalSet(collection, id, value);
    };

    await expect(
      adapter.compareAndSwapWorldMetadata({
        worldId: WORLD_ID,
        expectedMetadata: before as never,
        replacementMetadata: replacement as never,
        audit: {
          actorEntityId: ACTOR_ID,
          targetEntityId: TARGET_ID,
          previousRole: "USER",
          newRole: "ADMIN",
          source: "manual",
          roomId: ROOM_ID,
        },
      })
    ).rejects.toThrow("audit storage unavailable");

    const afterAuditThrow = await storedMetadata(adapter);
    expect((afterAuditThrow as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe(
      "USER"
    );
    expect(await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE })).toHaveLength(0);
  });

  it.each(["updateWorlds", "upsertWorlds"] as const)(
    "rejects a legacy %s writer that resumes from a pre-CAS snapshot",
    async (legacyMethod) => {
      const adapter = await buildAdapter();
      let signalRead!: () => void;
      let releaseWriter!: () => void;
      const readComplete = new Promise<void>((resolve) => {
        signalRead = resolve;
      });
      const writerGate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const legacyWriter = (async () => {
        const staleWorld = (await adapter.getWorldsByIds([WORLD_ID]))[0];
        signalRead();
        await writerGate;
        if (!staleWorld) throw new Error("test world missing");
        (staleWorld.metadata as { roles: Record<string, string> }).roles[String(TARGET_ID)] =
          "GUEST";
        await adapter[legacyMethod]([staleWorld]);
      })();
      await readComplete;

      const before = await storedMetadata(adapter);
      const replacement = structuredClone(before);
      (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
      const casResult = await adapter.compareAndSwapWorldMetadata({
        worldId: WORLD_ID,
        expectedMetadata: structuredClone(before) as never,
        replacementMetadata: replacement as never,
      });
      releaseWriter();
      await expect(legacyWriter).rejects.toMatchObject({ code: "WORLD_METADATA_STALE_WRITE" });
      const after = await storedMetadata(adapter);
      const finalRole = (after as { roles: Record<string, string> }).roles[String(TARGET_ID)];
      expect(casResult).toEqual({ status: "updated" });
      expect(finalRole).toBe("ADMIN");
    }
  );

  it.each(["updateWorlds", "upsertWorlds"] as const)(
    "rejects a malformed revision from legacy %s",
    async (legacyMethod) => {
      const adapter = await buildAdapter();
      const world = (await adapter.getWorldsByIds([WORLD_ID]))[0];
      if (!world?.metadata) throw new Error("test world metadata missing");
      (world.metadata as Record<string, unknown>)[WORLD_METADATA_REVISION_KEY] = "invalid";

      await expect(adapter[legacyMethod]([world])).rejects.toMatchObject({
        code: "WORLD_METADATA_STALE_WRITE",
      });
      const after = await storedMetadata(adapter);
      expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("USER");
    }
  );

  it("serializes concurrent CAS calls ACROSS adapter instances sharing one storage", async () => {
    // Two adapters over the SAME MemoryStorage: an adapter-local tail would
    // let both win; the storage-scoped tail must serialize them.
    const storage = new MemoryStorage();
    const adapterA = new InMemoryDatabaseAdapter(storage, AGENT_ID);
    const adapterB = new InMemoryDatabaseAdapter(storage, AGENT_ID);
    await adapterA.init();
    await adapterB.init();
    await adapterA.createWorlds([
      {
        id: WORLD_ID,
        agentId: AGENT_ID,
        name: "cas-world",
        metadata: structuredClone(BASE_METADATA) as unknown as World["metadata"],
      },
    ]);
    const before = await storedMetadata(adapterA);

    const mkParams = (marker: string) => {
      const replacement = structuredClone(before);
      (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
      (replacement as { marker?: string }).marker = marker;
      return {
        worldId: WORLD_ID,
        expectedMetadata: structuredClone(before) as never,
        replacementMetadata: replacement as never,
        audit: {
          actorEntityId: ACTOR_ID,
          targetEntityId: TARGET_ID,
          previousRole: "USER",
          newRole: "ADMIN",
          source: "manual",
          roomId: ROOM_ID,
        },
      };
    };
    const [fromA, fromB] = await Promise.all([
      adapterA.compareAndSwapWorldMetadata(mkParams("first")),
      adapterB.compareAndSwapWorldMetadata(mkParams("second")),
    ]);
    const outcomes = [fromA.status, fromB.status].sort();
    expect(outcomes).toEqual(["conflict", "updated"]);
    expect(await adapterA.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE })).toHaveLength(1);
    const after = await storedMetadata(adapterB);
    expect((after as { marker?: string }).marker).toBeDefined();
  });

  /**
   * Wraps a MemoryStorage so its first world WRITE (set) parks until
   * released, exposing an `entered` promise that resolves the moment the
   * write parks. The CAS always reads before parking (read → compare →
   * audit insert → park → write), so awaiting `entered` and acting before
   * `release()` places the test's delete / create actor strictly between
   * the CAS's read and its write — the exact interleaving the r4 P0
   * forbids. Gating the read instead would make the forbidden outcome
   * impossible even pre-fix (the CAS would observe the actor at compare).
   */
  function gatedWorldWrite(storage: MemoryStorage) {
    let release!: () => void;
    let markEntered!: () => void;
    // Resolved immediately BEFORE parking on the gate: awaiting `entered`
    // proves the CAS reached its world write and is parked — no timing
    // assumption about scheduler delay.
    const entered = new Promise<void>((r) => (markEntered = r));
    const gate = new Promise<void>((r) => (release = r));
    const origSet = storage.set.bind(storage);
    let armed = true;
    storage.set = async (collection: string, id: string, data: unknown) => {
      if (armed && collection === COLLECTIONS.WORLDS) {
        armed = false;
        markEntered();
        await gate;
      }
      return origSet(collection, id, data as never);
    };
    return { release, entered };
  }

  it("cannot resurrect a world deleted between the CAS read and its write", async () => {
    const storage = new MemoryStorage();
    const adapter = await buildAdapterOn(storage);
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
    // Park the CAS on its world WRITE; with the park proven via the
    // entered handshake, delete the world while it is parked. Pre-fix
    // (createWorlds/deleteWorlds NOT on the tail) the delete lands and the
    // parked CAS write resurrects the world; post-fix the delete queues
    // behind the tail and runs only after the CAS completes.
    // Forbidden: CAS=updated AND world still present.
    const gated = gatedWorldWrite(storage);
    const casPromise = adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: structuredClone(before) as never,
      replacementMetadata: replacement as never,
    });
    await gated.entered; // CAS is proven parked on its world write
    // Fire WITHOUT awaiting yet: post-fix deleteWorlds queues on the tail
    // the parked CAS holds, so awaiting it here would deadlock the test.
    const deletion = adapter.deleteWorlds([WORLD_ID]);
    gated.release();
    const casResult = await casPromise;
    await deletion; // the queued delete completes before final assertions
    const after = await adapter.getWorldsByIds([WORLD_ID]);
    expect(after).toHaveLength(0);
    if (casResult.status !== "updated" && casResult.status !== "not_found") {
      throw new Error(`unexpected CAS outcome: ${JSON.stringify(casResult)}`);
    }
  });

  it("does not let a stale CAS clobber a freshly created world", async () => {
    const storage = new MemoryStorage();
    const adapter = await buildAdapterOn(storage);
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
    // Park the CAS on its world WRITE (proven via the entered handshake)
    // while it holds the ORIGINAL snapshot; then delete and recreate the
    // world with different metadata. Pre-fix the recreate interleaves and
    // the parked CAS write clobbers the fresh world; post-fix it queues
    // behind the tail. Forbidden: CAS=updated over the fresh metadata.
    const gated = gatedWorldWrite(storage);
    const casPromise = adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: structuredClone(before) as never,
      replacementMetadata: replacement as never,
    });
    await gated.entered; // CAS is proven parked on its world write
    // Fire WITHOUT awaiting: post-fix the actor queues on the tail behind
    // the parked CAS; awaiting it here would deadlock the test.
    const actor = (async () => {
      await adapter.deleteWorlds([WORLD_ID]);
      await adapter.createWorlds([
        {
          id: WORLD_ID,
          agentId: AGENT_ID,
          name: "cas-world",
          metadata: {
            ownership: { ownerId: String(ACTOR_ID) },
            roles: { [String(ACTOR_ID)]: "OWNER", [String(TARGET_ID)]: "GUEST" },
          } as unknown as World["metadata"],
        },
      ]);
    })();
    // Let the un-serialized (pre-fix) actor drain fully BEFORE releasing the
    // parked CAS write: pre-fix this deterministically produces the clobber
    // (stale CAS write lands last, over the fresh world); post-fix the actor
    // has queued on the tail and the CAS commits first instead.
    await new Promise((r) => setTimeout(r, 5));
    gated.release();
    const casResult = await casPromise;
    await actor; // both orders complete before we assert on final state
    const after = await storedMetadata(adapter);
    if (casResult.status === "updated") {
      // CAS committed first; the recreate then replaced it — the final
      // state is the recreated metadata, not a stale-CAS clobber of it.
      expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("GUEST");
    } else {
      expect(casResult.status).toBe("conflict");
      expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("GUEST");
    }
  });

  it("serializes concurrent CAS calls so exactly one wins per snapshot", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const mkParams = (marker: string) => {
      const replacement = structuredClone(before);
      (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
      (replacement as { marker?: string }).marker = marker;
      return {
        worldId: WORLD_ID,
        expectedMetadata: structuredClone(before) as never,
        replacementMetadata: replacement as never,
        audit: {
          actorEntityId: ACTOR_ID,
          targetEntityId: TARGET_ID,
          previousRole: "USER",
          newRole: "ADMIN",
          source: "manual",
          roomId: ROOM_ID,
        },
      };
    };
    // Two racing CAS calls with the SAME expected snapshot: both read the
    // same pre-state, but the mutation tail must serialize them so the
    // second comparison sees the first one's write and returns conflict.
    const [first, second] = await Promise.all([
      adapter.compareAndSwapWorldMetadata(mkParams("first")),
      adapter.compareAndSwapWorldMetadata(mkParams("second")),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(["conflict", "updated"]);
    // Exactly one audit row: the winner's. The loser left none.
    expect(await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE })).toHaveLength(1);
    const after = await storedMetadata(adapter);
    expect((after as { marker?: string }).marker).toBeDefined();
  });

  it("returns detached world reads so in-place caller mutation cannot alter storage", async () => {
    const adapter = await buildAdapter();
    const world = (await adapter.getWorldsByIds([WORLD_ID]))[0];
    const liveMetadata = world?.metadata as Record<string, unknown>;
    const frozen = structuredClone(liveMetadata);
    (liveMetadata as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "GUEST";
    const unchanged = await storedMetadata(adapter);
    expect((unchanged as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("USER");
    const replacement = structuredClone(frozen);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: frozen as never,
      replacementMetadata: replacement as never,
    });
    expect(result).toEqual({ status: "updated" });
  });

  it("rolls the audit row back when the world write fails after insertion", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";

    // Storage that accepts the LOGS write but rejects the WORLDS write:
    // the audit insert succeeds, the world replacement throws — the audit
    // row must be compensated away so no false committed record survives.
    const storage = adapter.storage as unknown as {
      set: (collection: string, id: string, value: unknown) => Promise<void>;
    };
    const originalSet = storage.set.bind(storage);
    storage.set = async (collection, id, value) => {
      if (collection === "worlds") {
        throw new Error("world storage unavailable");
      }
      return originalSet(collection, id, value);
    };

    await expect(
      adapter.compareAndSwapWorldMetadata({
        worldId: WORLD_ID,
        expectedMetadata: before as never,
        replacementMetadata: replacement as never,
        audit: {
          actorEntityId: ACTOR_ID,
          targetEntityId: TARGET_ID,
          previousRole: "USER",
          newRole: "ADMIN",
          source: "manual",
          roomId: ROOM_ID,
        },
      })
    ).rejects.toThrow("world storage unavailable");

    // Restore the real setter before asserting through it.
    storage.set = originalSet;
    expect(await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE })).toHaveLength(0);
    const after = await storedMetadata(adapter);
    expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("USER");
  });
});
