/**
 * P0-7 unit tests — bench-server role seeding.
 *
 * These tests pin the contract the personality `scope_global_vs_user`
 * bucket depends on. The bench server must let a runner pin a sender's
 * identity + role so the runtime's `hasRoleAccess(ADMIN)` resolves to
 * the right verdict for admin senders and rejects regular users.
 *
 * They run against the real `setEntityRole`/`hasRoleAccess` helpers from
 * `@elizaos/core` so a regression in role resolution would fail the test
 * even if our seeding code stayed the same.
 */

import { hasRoleAccess, stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_OWNER_ENTITY_ID,
  BENCHMARK_WORLD_ID,
  createSession,
  ensureBenchmarkSessionContext,
  normalizeBenchRoleName,
  seedBenchUserRole,
} from "../server-utils.js";

// ---------------------------------------------------------------------------
// Minimal in-memory runtime that implements the surface our code touches.
// We do NOT spin a full AgentRuntime — these tests target the role-seeding
// contract specifically. The runtime stubs return defaults that match the
// real implementation's behavior under "no settings configured".
// ---------------------------------------------------------------------------

interface FakeWorld {
  id: UUID;
  agentId: UUID;
  name?: string;
  messageServerId?: UUID;
  metadata?: Record<string, unknown>;
}

interface FakeRoom {
  id: UUID;
  name?: string;
  source: string;
  type: string;
  worldId?: UUID;
  channelId?: string;
  messageServerId?: UUID;
  metadata?: Record<string, unknown>;
}

function makeFakeRuntime(): {
  runtime: Parameters<typeof ensureBenchmarkSessionContext>[0];
  rt: {
    worlds: Map<UUID, FakeWorld>;
    rooms: Map<UUID, FakeRoom>;
    settings: Map<string, unknown>;
  };
} {
  const worlds = new Map<UUID, FakeWorld>();
  const rooms = new Map<UUID, FakeRoom>();
  const settings = new Map<string, unknown>();
  const agentId = stringToUuid("test-bench-agent");

  const runtime = {
    agentId,
    async ensureWorldExists(world: FakeWorld) {
      if (!worlds.has(world.id)) worlds.set(world.id, world);
    },
    async ensureRoomExists(room: FakeRoom) {
      if (!rooms.has(room.id)) rooms.set(room.id, room);
    },
    async ensureConnection() {
      /* no-op for these tests */
    },
    async ensureParticipantInRoom() {
      /* no-op */
    },
    async getWorld(worldId: UUID) {
      return worlds.get(worldId) ?? null;
    },
    async getRoom(roomId: UUID) {
      return rooms.get(roomId) ?? null;
    },
    async updateWorld(world: FakeWorld) {
      worlds.set(world.id, world);
    },
    getSetting(key: string) {
      return settings.get(key) ?? null;
    },
    setSetting(key: string, value: unknown) {
      settings.set(key, value);
    },
    async getRelationships() {
      return [];
    },
    async getEntitiesByIds() {
      return [];
    },
  } as unknown as Parameters<typeof ensureBenchmarkSessionContext>[0];

  return { runtime, rt: { worlds, rooms, settings } };
}

describe("ensureBenchmarkSessionContext — world ownership", () => {
  it("pins BENCHMARK_OWNER_ENTITY_ID as the world owner on first create", async () => {
    const { runtime, rt } = makeFakeRuntime();
    const session = createSession("task-owner-1", "personality_bench");

    await ensureBenchmarkSessionContext(runtime, session);

    const world = rt.worlds.get(BENCHMARK_WORLD_ID);
    expect(world).toBeDefined();
    const ownership = (world?.metadata as { ownership?: { ownerId?: string } })
      ?.ownership;
    expect(ownership?.ownerId).toBe(BENCHMARK_OWNER_ENTITY_ID);
  });

  it("backfills ownership.ownerId on a pre-existing world that lacks it", async () => {
    const { runtime, rt } = makeFakeRuntime();
    // Pre-seed an old-style bench world missing ownership.
    rt.worlds.set(BENCHMARK_WORLD_ID, {
      id: BENCHMARK_WORLD_ID,
      agentId: stringToUuid("test-bench-agent"),
      metadata: { type: "benchmark", description: "stale" },
    });
    const session = createSession("task-owner-2", "personality_bench");

    await ensureBenchmarkSessionContext(runtime, session);

    const world = rt.worlds.get(BENCHMARK_WORLD_ID);
    const ownership = (world?.metadata as { ownership?: { ownerId?: string } })
      ?.ownership;
    expect(ownership?.ownerId).toBe(BENCHMARK_OWNER_ENTITY_ID);
  });
});

describe("seedBenchUserRole", () => {
  it("writes ADMIN into world.metadata.roles for the seeded entity", async () => {
    const { runtime, rt } = makeFakeRuntime();
    const session = createSession("task-admin", "personality_bench");
    await ensureBenchmarkSessionContext(runtime, session);

    const adminEntityId = stringToUuid("admin-entity");
    await seedBenchUserRole(runtime, session, adminEntityId, "ADMIN");

    const world = rt.worlds.get(BENCHMARK_WORLD_ID);
    const roles = (world?.metadata as { roles?: Record<string, string> })
      ?.roles;
    expect(roles?.[adminEntityId]).toBe("ADMIN");
  });

  it("writes USER for non-admin senders", async () => {
    const { runtime, rt } = makeFakeRuntime();
    const session = createSession("task-user", "personality_bench");
    await ensureBenchmarkSessionContext(runtime, session);

    const userEntityId = stringToUuid("user-entity");
    await seedBenchUserRole(runtime, session, userEntityId, "USER");

    const world = rt.worlds.get(BENCHMARK_WORLD_ID);
    const roles = (world?.metadata as { roles?: Record<string, string> })
      ?.roles;
    expect(roles?.[userEntityId]).toBe("USER");
  });
});

describe("hasRoleAccess against a seeded bench world", () => {
  it("returns true for an ADMIN-seeded sender requesting ADMIN", async () => {
    const { runtime, rt } = makeFakeRuntime();
    const session = createSession("task-admin-check", "personality_bench");
    await ensureBenchmarkSessionContext(runtime, session);

    const adminEntityId = stringToUuid("admin-entity-check");
    await seedBenchUserRole(runtime, session, adminEntityId, "ADMIN");

    const allowed = await hasRoleAccess(
      // biome-ignore lint/suspicious/noExplicitAny: cross-module structural fake.
      runtime as any,
      // biome-ignore lint/suspicious/noExplicitAny: cross-module structural fake.
      {
        id: stringToUuid("probe-admin-msg"),
        entityId: adminEntityId,
        agentId: rt.worlds.get(BENCHMARK_WORLD_ID)?.agentId,
        roomId: session.roomId,
        content: { text: "probe", source: "benchmark" },
        createdAt: Date.now(),
      } as any,
      "ADMIN",
    );
    expect(allowed).toBe(true);
  });

  it("returns false for a USER-seeded sender requesting ADMIN", async () => {
    const { runtime } = makeFakeRuntime();
    const session = createSession("task-user-check", "personality_bench");
    await ensureBenchmarkSessionContext(runtime, session);

    const userEntityId = stringToUuid("user-entity-check");
    await seedBenchUserRole(runtime, session, userEntityId, "USER");

    const allowed = await hasRoleAccess(
      // biome-ignore lint/suspicious/noExplicitAny: cross-module structural fake.
      runtime as any,
      // biome-ignore lint/suspicious/noExplicitAny: cross-module structural fake.
      {
        id: stringToUuid("probe-user-msg"),
        entityId: userEntityId,
        agentId: runtime.agentId,
        roomId: session.roomId,
        content: { text: "probe", source: "benchmark" },
        createdAt: Date.now(),
      } as any,
      "ADMIN",
    );
    expect(allowed).toBe(false);
  });

  it("returns true for the canonical owner entity without explicit role", async () => {
    const { runtime } = makeFakeRuntime();
    const session = createSession("task-owner-check", "personality_bench");
    await ensureBenchmarkSessionContext(runtime, session);

    // No setEntityRole call — the canonical owner gets through via
    // isCanonicalOwner (world.metadata.ownership.ownerId).
    const allowed = await hasRoleAccess(
      // biome-ignore lint/suspicious/noExplicitAny: cross-module structural fake.
      runtime as any,
      // biome-ignore lint/suspicious/noExplicitAny: cross-module structural fake.
      {
        id: stringToUuid("probe-owner-msg"),
        entityId: BENCHMARK_OWNER_ENTITY_ID,
        agentId: runtime.agentId,
        roomId: session.roomId,
        content: { text: "probe", source: "benchmark" },
        createdAt: Date.now(),
      } as any,
      "ADMIN",
    );
    expect(allowed).toBe(true);
  });
});

describe("normalizeBenchRoleName", () => {
  it("accepts the four canonical role tokens", () => {
    expect(normalizeBenchRoleName("OWNER")).toBe("OWNER");
    expect(normalizeBenchRoleName("ADMIN")).toBe("ADMIN");
    expect(normalizeBenchRoleName("USER")).toBe("USER");
    expect(normalizeBenchRoleName("GUEST")).toBe("GUEST");
  });

  it("maps `member` and lowercase variants from the runner's vocabulary", () => {
    expect(normalizeBenchRoleName("admin")).toBe("ADMIN");
    expect(normalizeBenchRoleName("member")).toBe("USER");
    expect(normalizeBenchRoleName(" Admin ")).toBe("ADMIN");
  });

  it("returns null for unknown or missing values", () => {
    expect(normalizeBenchRoleName(undefined)).toBeNull();
    expect(normalizeBenchRoleName("")).toBeNull();
    expect(normalizeBenchRoleName("superuser")).toBeNull();
    expect(normalizeBenchRoleName(42)).toBeNull();
  });
});
