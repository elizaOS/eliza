/**
 * Exercises the #23100 world-metadata compare-and-swap against real SQL
 * storage (PGlite, or Postgres when POSTGRES_URL is set): snapshot match and
 * mismatch, jsonb value equality with key order differences, audit-row
 * atomicity (the log row rides the CAS transaction), and world-not-found.
 * Real adapter, real migration system, no mocked storage.
 */
import { ChannelType, ROLE_WRITE_AUDIT_LOG_TYPE, type UUID, type World } from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../test-helpers";

const WORLD_ID = v4() as UUID;
const ACTOR_ID = "60000000-0000-0000-0000-000000000001" as UUID;
const TARGET_ID = "60000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = v4() as UUID;

const BASE_METADATA = {
  ownership: { ownerId: String(ACTOR_ID) },
  roles: { [String(ACTOR_ID)]: "OWNER", [String(TARGET_ID)]: "USER" },
};

describe("compareAndSwapWorldMetadata (real SQL parity)", () => {
  let adapter: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["adapter"];
  let cleanup: () => Promise<void>;
  let agentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("world_metadata_cas");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;
    // The logs table enforces real foreign keys (entity_id -> entities.id,
    // room_id -> rooms.id), so the audit row needs live actor and room rows —
    // exactly as production role writes always run against real entities.
    await adapter.createEntities([
      {
        id: ACTOR_ID,
        agentId,
        names: ["cas-actor"],
      },
      {
        id: TARGET_ID,
        agentId,
        names: ["cas-target"],
      },
    ]);
    const roomIds = await adapter.createRooms([
      {
        id: ROOM_ID,
        agentId,
        worldId: WORLD_ID,
        source: "world-metadata-cas",
        type: ChannelType.WORLD,
      },
    ]);
    if (!roomIds.includes(ROOM_ID)) {
      throw new Error("test room was not created");
    }
    await adapter.createWorld({
      id: WORLD_ID,
      agentId,
      name: "World metadata CAS world",
      serverId: "world-metadata-cas",
      metadata: BASE_METADATA as unknown as World["metadata"],
    } as World);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function storedMetadata(): Promise<Record<string, unknown>> {
    const rows = await adapter.getWorldsByIds([WORLD_ID]);
    return (rows[0]?.metadata ?? {}) as Record<string, unknown>;
  }

  it("commits when the snapshot matches, updating metadata and audit together", async () => {
    const before = await storedMetadata();
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
    const after = await storedMetadata();
    expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("ADMIN");
    const logs = await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE });
    expect(logs).toHaveLength(1);
    const body = logs[0]?.body as { source: string; metadata?: Record<string, unknown> };
    expect(body?.source).toBe("role-write-cas");
    expect(body?.metadata?.previousRole).toBe("USER");
    expect(body?.metadata?.newRole).toBe("ADMIN");
    expect(body?.metadata?.outcome).toBe("committed");
  });

  it("conflicts when the stored metadata drifted from the snapshot", async () => {
    const before = await storedMetadata();
    // Someone else writes first (a plain role change, no schema drift).
    const raced = structuredClone(before);
    (raced as { roles: Record<string, string> }).roles[String(TARGET_ID)] = "GUEST";
    const racedResult = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: before as never,
      replacementMetadata: raced as never,
    });
    expect(racedResult).toEqual({ status: "updated" });

    // Now the stale snapshot must conflict, not overwrite: its extra key must
    // never land, and the racing writer's role change must survive.
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: before as never,
      replacementMetadata: { ...before, extra: "y" } as never,
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
    const after = await storedMetadata();
    expect(after).not.toHaveProperty("extra");
    expect((after as { roles: Record<string, string> }).roles[String(TARGET_ID)]).toBe("GUEST");
    // No audit row for the lost attempt.
    const logs = await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE });
    expect(logs).toHaveLength(1);
  });

  it("treats key order as insignificant (jsonb value equality)", async () => {
    const before = await storedMetadata();
    // Same keys and values, opposite top-level insertion order: jsonb (and
    // the value-equality contract) must treat this as the same snapshot.
    // Adding or removing a key is a value change and must conflict — the
    // drift test above covers that direction.
    const reordered = { roles: before.roles, ownership: before.ownership };
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: WORLD_ID,
      expectedMetadata: reordered as never,
      replacementMetadata: structuredClone(before) as never,
    });
    expect(result).toEqual({ status: "updated" });
  });

  it("reports not_found for an unknown world", async () => {
    const result = await adapter.compareAndSwapWorldMetadata({
      worldId: v4() as UUID,
      expectedMetadata: {} as never,
      replacementMetadata: {} as never,
    });
    expect(result).toEqual({ status: "not_found" });
  });
});
