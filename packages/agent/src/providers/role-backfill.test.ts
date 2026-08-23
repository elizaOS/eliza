/**
 * Unit coverage for roleBackfillProvider. The provider is real; core owner
 * resolution (resolveCanonicalOwnerId / hasConfiguredCanonicalOwner /
 * normalizeRole) is real. Only runtime collaborators (getRoom, getWorld,
 * updateWorld, getSetting) are in-memory fakes.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { roleBackfillProvider } from "./role-backfill.ts";

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };
const EMPTY_RESULT = { text: "", values: {}, data: {} };

const ROOM_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const AGENT_ID = "00000000-0000-4000-8000-0000000000cc" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const STALE_OWNER_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ADMIN_ID = "00000000-0000-4000-8000-000000000003" as UUID;

function message(): Memory {
  return {
    id: "00000000-0000-4000-8000-0000000000a1" as UUID,
    entityId: "00000000-0000-4000-8000-0000000000e0" as UUID,
    roomId: ROOM_ID,
    content: { text: "hello" },
  } as Memory;
}

type WorldMetadata = {
  ownership?: { ownerId?: string; extra?: string };
  roles?: Record<string, string>;
  roleSources?: Record<string, string>;
  note?: string;
};

function makeRuntime(options: {
  room?: { worldId?: string } | null;
  world?: {
    id?: string;
    metadata?: WorldMetadata;
  } | null;
  settings?: Record<string, string>;
  getRoom?: () => Promise<unknown>;
  getWorld?: () => Promise<unknown>;
  updateWorld?: (world: unknown) => Promise<unknown>;
}): {
  runtime: IAgentRuntime;
  updateWorld: ReturnType<typeof vi.fn>;
} {
  const updateWorld = vi.fn(options.updateWorld ?? (async () => undefined));
  const runtime = {
    agentId: AGENT_ID,
    getSetting: (key: string) => options.settings?.[key],
    getRoom:
      options.getRoom ??
      (async () =>
        options.room === undefined
          ? { id: ROOM_ID, worldId: WORLD_ID }
          : options.room),
    getWorld:
      options.getWorld ??
      (async () =>
        options.world === undefined
          ? {
              id: WORLD_ID,
              agentId: AGENT_ID,
              name: "test-world",
              metadata: {},
            }
          : options.world === null
            ? null
            : {
                id: options.world.id ?? WORLD_ID,
                agentId: AGENT_ID,
                name: "test-world",
                metadata: options.world.metadata,
              }),
    updateWorld,
  } as unknown as IAgentRuntime;
  return { runtime, updateWorld };
}

describe("roleBackfillProvider registration", () => {
  it("is a silent admin/settings provider that runs after the roles provider", () => {
    expect(roleBackfillProvider.name).toBe("roleBackfill");
    expect(roleBackfillProvider.position).toBe(11);
    expect(roleBackfillProvider.dynamic).toBe(true);
    expect(roleBackfillProvider.cacheStable).toBe(false);
    expect(roleBackfillProvider.cacheScope).toBe("turn");
    expect(roleBackfillProvider.contexts).toEqual(["admin", "settings"]);
    expect(roleBackfillProvider.contextGate).toEqual({
      anyOf: ["admin", "settings"],
    });
    expect(roleBackfillProvider.roleGate).toEqual({ minRole: "ADMIN" });
  });
});

describe("roleBackfillProvider.get early exits", () => {
  it("returns empty and does not update when the room has no worldId", async () => {
    const { runtime, updateWorld } = makeRuntime({
      room: { worldId: undefined },
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("returns empty and does not update when the room is missing", async () => {
    const { runtime, updateWorld } = makeRuntime({ room: null });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("returns empty and does not update when the world is missing", async () => {
    const { runtime, updateWorld } = makeRuntime({ world: null });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("returns empty when ownership.ownerId is empty and no owner is configured", async () => {
    const { runtime, updateWorld } = makeRuntime({
      world: { metadata: { ownership: { ownerId: "" } } },
      settings: {},
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("returns empty when world metadata is empty and no owner is configured", async () => {
    const { runtime, updateWorld } = makeRuntime({
      world: { metadata: {} },
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("swallows getRoom failures and still returns empty", async () => {
    const { runtime, updateWorld } = makeRuntime({
      getRoom: async () => {
        throw new Error("room store unavailable");
      },
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("swallows getWorld failures and still returns empty", async () => {
    const { runtime, updateWorld } = makeRuntime({
      getWorld: async () => {
        throw new Error("world store unavailable");
      },
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });
});

describe("roleBackfillProvider.get idempotent skip", () => {
  it("does not update a world that already has OWNER, ownership, and owner source", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "OWNER" },
          roleSources: { [OWNER_ID]: "owner" },
        },
      },
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("treats a lowercase stored owner role as already OWNER", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "owner" },
          roleSources: { [OWNER_ID]: "owner" },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).not.toHaveBeenCalled();
  });

  it("does not strip extra OWNER entries when no canonical owner is configured", async () => {
    const { runtime, updateWorld } = makeRuntime({
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "OWNER", [STALE_OWNER_ID]: "OWNER" },
          roleSources: {
            [OWNER_ID]: "owner",
            [STALE_OWNER_ID]: "owner",
          },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).not.toHaveBeenCalled();
  });
});

describe("roleBackfillProvider.get backfill", () => {
  it("backfills OWNER onto an empty new-world roles map from the configured owner", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: { metadata: {} },
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(updateWorld).toHaveBeenCalledTimes(1);
    expect(updateWorld).toHaveBeenCalledWith(
      expect.objectContaining({
        id: WORLD_ID,
        metadata: expect.objectContaining({
          ownership: expect.objectContaining({ ownerId: OWNER_ID }),
          roles: { [OWNER_ID]: "OWNER" },
          roleSources: { [OWNER_ID]: "owner" },
        }),
      }),
    );
  });

  it("backfills OWNER from metadata.ownership when no owner setting is configured", async () => {
    const { runtime, updateWorld } = makeRuntime({
      world: {
        metadata: { ownership: { ownerId: OWNER_ID } },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).toHaveBeenCalledTimes(1);
    expect(updateWorld).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          roles: { [OWNER_ID]: "OWNER" },
          roleSources: { [OWNER_ID]: "owner" },
        }),
      }),
    );
  });

  it("upgrades a single ADMIN entry for the owner to OWNER", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "ADMIN" },
          roleSources: { [OWNER_ID]: "manual" },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          roles: { [OWNER_ID]: "OWNER" },
          roleSources: { [OWNER_ID]: "owner" },
        }),
      }),
    );
  });

  it("does not treat MEMBER as OWNER and still backfills", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "MEMBER" },
          roleSources: { [OWNER_ID]: "manual" },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).toHaveBeenCalledTimes(1);
    const payload = updateWorld.mock.calls[0]?.[0] as {
      metadata: { roles: Record<string, string> };
    };
    expect(payload.metadata.roles[OWNER_ID]).toBe("OWNER");
  });

  it("syncs ownership.ownerId when it disagrees with the configured owner", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: STALE_OWNER_ID, extra: "keep-me" },
          roles: { [OWNER_ID]: "OWNER" },
          roleSources: { [OWNER_ID]: "owner" },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).toHaveBeenCalledTimes(1);
    const payload = updateWorld.mock.calls[0]?.[0] as {
      metadata: { ownership: { ownerId: string; extra?: string } };
    };
    expect(payload.metadata.ownership.ownerId).toBe(OWNER_ID);
    expect(payload.metadata.ownership.extra).toBe("keep-me");
  });

  it("syncs roleSources when the owner role is present but the source is not owner", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "OWNER" },
          roleSources: { [OWNER_ID]: "manual" },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          roleSources: { [OWNER_ID]: "owner" },
        }),
      }),
    );
  });

  it("syncs roleSources when the owner role exists but the source map is missing", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "OWNER" },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).toHaveBeenCalledTimes(1);
    const payload = updateWorld.mock.calls[0]?.[0] as {
      metadata: { roleSources: Record<string, string> };
    };
    expect(payload.metadata.roleSources[OWNER_ID]).toBe("owner");
  });

  it("removes stale OWNER entries when a canonical owner is configured", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: {
            [OWNER_ID]: "OWNER",
            [STALE_OWNER_ID]: "OWNER",
            [ADMIN_ID]: "ADMIN",
          },
          roleSources: {
            [OWNER_ID]: "owner",
            [STALE_OWNER_ID]: "owner",
            [ADMIN_ID]: "manual",
          },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    expect(updateWorld).toHaveBeenCalledTimes(1);
    const payload = updateWorld.mock.calls[0]?.[0] as {
      metadata: {
        roles: Record<string, string>;
        roleSources: Record<string, string>;
      };
    };
    expect(payload.metadata.roles[OWNER_ID]).toBe("OWNER");
    expect(payload.metadata.roles[STALE_OWNER_ID]).toBeUndefined();
    expect(payload.metadata.roleSources[STALE_OWNER_ID]).toBeUndefined();
    expect(payload.metadata.roles[ADMIN_ID]).toBe("ADMIN");
    expect(payload.metadata.roleSources[ADMIN_ID]).toBe("manual");
  });

  it("treats a lowercase stale owner role as OWNER and removes it", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "OWNER", [STALE_OWNER_ID]: "owner" },
          roleSources: {
            [OWNER_ID]: "owner",
            [STALE_OWNER_ID]: "manual",
          },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    const payload = updateWorld.mock.calls[0]?.[0] as {
      metadata: {
        roles: Record<string, string>;
        roleSources: Record<string, string>;
      };
    };
    expect(payload.metadata.roles[STALE_OWNER_ID]).toBeUndefined();
    expect(payload.metadata.roleSources[STALE_OWNER_ID]).toBeUndefined();
  });

  it("does not invent a delete for a missing stale id and keeps unrelated roles", async () => {
    const { runtime, updateWorld } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: {
        metadata: {
          note: "keep-extra",
          ownership: { ownerId: OWNER_ID },
          roles: { [OWNER_ID]: "GUEST", [ADMIN_ID]: "USER" },
          roleSources: { [ADMIN_ID]: "manual" },
        },
      },
    });
    await roleBackfillProvider.get(runtime, message(), EMPTY_STATE);
    const payload = updateWorld.mock.calls[0]?.[0] as {
      metadata: {
        note?: string;
        roles: Record<string, string>;
        roleSources: Record<string, string>;
      };
    };
    expect(payload.metadata.note).toBe("keep-extra");
    expect(payload.metadata.roles[ADMIN_ID]).toBe("USER");
    expect(payload.metadata.roles[STALE_OWNER_ID]).toBeUndefined();
    expect(payload.metadata.roleSources[ADMIN_ID]).toBe("manual");
  });

  it("still returns empty when updateWorld rejects", async () => {
    const { runtime } = makeRuntime({
      settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      world: { metadata: {} },
      updateWorld: async () => {
        throw new Error("write failed");
      },
    });
    const result = await roleBackfillProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );
    expect(result).toEqual(EMPTY_RESULT);
  });
});
