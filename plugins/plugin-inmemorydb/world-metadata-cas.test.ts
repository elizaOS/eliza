/**
 * Exercises the #23100 world-metadata compare-and-swap against the first-party
 * ephemeral adapter: snapshot match/mismatch, value equality with key-order
 * differences, audit-row placement (inserted before the swap so a storage
 * throw leaves the world untouched), and world-not-found. Real adapter over
 * real storage, no mocks.
 */
import { ROLE_WRITE_AUDIT_LOG_TYPE, type UUID, type World } from "@elizaos/core";
import { v4 } from "uuid";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "70000000-0000-0000-0000-000000000001" as UUID;
const ACTOR_ID = "70000000-0000-0000-0000-000000000002" as UUID;
const TARGET_ID = "70000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = v4() as UUID;
const WORLD_ID = v4() as UUID;

const BASE_METADATA = {
  ownership: { ownerId: String(ACTOR_ID) },
  roles: { [String(ACTOR_ID)]: "OWNER", [String(TARGET_ID)]: "USER" },
};

async function buildAdapter() {
  const adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);
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
    const reordered = { roles: before.roles, ownership: before.ownership };
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
      worldId: v4() as UUID,
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

  it("serializes a CAS against a legacy updateWorlds writer sharing the storage", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
    // A legacy whole-world writer races the CAS on the SAME storage: both
    // go through the world-metadata tail, so the blind write cannot land
    // between the CAS read/compare and its write. Whichever wins, the
    // other either conflicts (CAS lost) or the write precedes/follows the
    // CAS as a whole — the final state is exactly one of the two writes.
    const legacyMetadata = structuredClone(before);
    (legacyMetadata as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "GUEST";
    const [casResult] = await Promise.all([
      adapter.compareAndSwapWorldMetadata({
        worldId: WORLD_ID,
        expectedMetadata: structuredClone(before) as never,
        replacementMetadata: replacement as never,
      }),
      adapter.updateWorlds([
        {
          id: WORLD_ID,
          agentId: AGENT_ID,
          name: "cas-world",
          metadata: legacyMetadata as World["metadata"],
        },
      ]),
    ]);
    const after = await storedMetadata(adapter);
    const finalRole = (after as { roles: Record<string, string> }).roles[String(TARGET_ID)];
    // The serialization invariant: the legacy write lands WHOLE — either
    // entirely before the CAS (casResult=conflict) or entirely after it
    // (casResult=updated, then the blind writer overwrites; that residual
    // overwrite is the documented hazard of unmigrated legacy writers).
    // finalRole=ADMIN would be the INTERLEAVING signature — the legacy
    // write landing between the CAS read and its write, silently clobbered
    // — and is exactly what the shared tail prevents.
    expect(["updated", "conflict"]).toContain(casResult.status);
    expect(finalRole).toBe("GUEST");
  });

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

  it("cannot resurrect a world deleted between the CAS read and its write", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
    // Deletion lands between the CAS read/compare and its write; the
    // serialized tail means the delete runs either fully before (CAS then
    // reports not_found) or fully after (CAS updated, then world deleted).
    // The forbidden outcome is CAS=updated AND the world still present —
    // the resurrection signature.
    const [casResult] = await Promise.all([
      adapter.compareAndSwapWorldMetadata({
        worldId: WORLD_ID,
        expectedMetadata: structuredClone(before) as never,
        replacementMetadata: replacement as never,
      }),
      adapter.deleteWorlds([WORLD_ID]),
    ]);
    const after = await adapter.getWorldsByIds([WORLD_ID]);
    if (casResult.status === "updated") {
      expect(after).toHaveLength(0);
    } else {
      expect(casResult.status).toBe("not_found");
      expect(after).toHaveLength(0);
    }
  });

  it("does not let a stale CAS clobber a freshly created world", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
    // The world is deleted, then re-created with different metadata, while
    // a CAS holding the ORIGINAL snapshot runs. Serialized: either the
    // delete+create land first (CAS must conflict — the stored metadata is
    // the fresh one, not the stale snapshot) or the CAS lands first (then
    // delete+create replace it wholesale). The forbidden outcome is
    // CAS=updated over the freshly created metadata — the clobber.
    const [casResult] = await Promise.all([
      adapter.compareAndSwapWorldMetadata({
        worldId: WORLD_ID,
        expectedMetadata: structuredClone(before) as never,
        replacementMetadata: replacement as never,
      }),
      (async () => {
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
      })(),
    ]);
    if (casResult.status === "updated") {
      // CAS committed first; the recreate then replaced it — the final
      // state is the recreated metadata, not a stale-CAS clobber of it.
      const after = await storedMetadata(adapter);
      expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("GUEST");
    } else {
      expect(casResult.status).toBe("conflict");
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

  it("detects an in-place mutation of the live stored metadata (live-reference hazard)", async () => {
    const adapter = await buildAdapter();
    // The memory store returns the LIVE stored object; a legacy whole-world
    // writer mutating it in place after the caller's read must surface as a
    // conflict, not compare equal-because-aliased. The core CAS helper
    // guards this by freezing a cloned snapshot; prove the adapter itself
    // catches a drifted live object when passed as expectedMetadata.
    const world = (await adapter.getWorldsByIds([WORLD_ID]))[0];
    const liveMetadata = world?.metadata as Record<string, unknown>;
    // An independent frozen copy taken NOW:
    const frozen = structuredClone(liveMetadata);
    // A legacy writer mutates the live object in place (e.g. a direct
    // updateWorlds path holding the same reference):
    (liveMetadata as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "GUEST";
    const replacement = structuredClone(frozen);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: frozen as never,
      replacementMetadata: replacement as never,
    });
    // The stored (mutated-live) state differs from the frozen snapshot the
    // caller authorized against — conflict, not a silent merge.
    expect(result).toEqual({ status: "conflict" });
  });

  it("rolls the audit row back when the world write fails after insertion", async () => {
    const adapter = await buildAdapter();
    const before = await storedMetadata(adapter);
    const replacement = structuredClone(before);
    (replacement as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "ADMIN";

    // Storage that accepts the LOGS write but rejects the WORLDS write:
    // the audit insert succeeds, the world replacement throws — the audit
    // row must be compensated away so no false committed record survives.
    const storage = adapter["storage"] as unknown as {
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
