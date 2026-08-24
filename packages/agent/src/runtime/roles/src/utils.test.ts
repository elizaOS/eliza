/**
 * Deterministic unit tests for the roles utils barrel.
 * Drives the real role-resolution implementations re-exported from
 * `@elizaos/core` through `./utils.ts`: barrel wiring parity, canonical owner
 * settings resolution, connector-admin whitelist read/write/match, role
 * normalization, world/message resolution, and every resolution branch the
 * sender-role and private-access gates expose (including the fail-closed
 * error paths that must propagate instead of degrading to GUEST).
 */

import type { IAgentRuntime, Memory, UUID, World } from "@elizaos/core";
import {
  canModifyRole as coreCanModifyRole,
  checkSenderPrivateAccess as coreCheckSenderPrivateAccess,
  checkSenderRole as coreCheckSenderRole,
  getConfiguredOwnerEntityIds as coreGetConfiguredOwnerEntityIds,
  getConnectorAdminWhitelist as coreGetConnectorAdminWhitelist,
  getEntityRole as coreGetEntityRole,
  getLiveEntityMetadataFromMessage as coreGetLiveEntityMetadataFromMessage,
  hasConfiguredCanonicalOwner as coreHasConfiguredCanonicalOwner,
  matchEntityToConnectorAdminWhitelist as coreMatchEntityToConnectorAdminWhitelist,
  normalizeRole as coreNormalizeRole,
  resolveCanonicalOwnerId as coreResolveCanonicalOwnerId,
  resolveCanonicalOwnerIdForMessage as coreResolveCanonicalOwnerIdForMessage,
  resolveEntityRole as coreResolveEntityRole,
  resolveWorldForMessage as coreResolveWorldForMessage,
  setConnectorAdminWhitelist as coreSetConnectorAdminWhitelist,
  setEntityRole as coreSetEntityRole,
  ElizaError,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import * as roles from "./utils.ts";

const ROOM_ID = "00000000-0000-0000-0000-000000000010" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000020" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const AGENT_ID = "99999999-9999-9999-9999-999999999999" as UUID;
const ACTOR_ID = "11111111-2222-3333-4444-555566667777" as UUID;
const OTHER_ID = "88888888-9999-aaaa-bbbb-ccccddddeeee" as UUID;
const STRANGER_ID = "33333333-4444-5555-6666-777788889999" as UUID;
const RECORDED_OWNER_ID = "44444444-5555-6666-7777-888899990000" as UUID;

const CANONICAL_OWNER_KEY = "ELIZA_ADMIN_ENTITY_ID";
const OWNER_CONTACTS_KEY = "ELIZA_OWNER_CONTACTS_JSON";
const CONNECTOR_ADMINS_KEY = "ELIZA_ROLES_CONNECTOR_ADMINS_JSON";

/**
 * Structural mirror of the world-metadata contract with relaxed role/source
 * strings, so fixtures can exercise the runtime normalizer with raw stored
 * values ("admin", legacy grants) that the strict public type forbids.
 */
type WorldMetadataFixture = {
  roles?: Record<string, string>;
  roleSources?: Record<string, string>;
  ownership?: { ownerId?: string };
};

type RolesWorldMetadata = NonNullable<
  Parameters<typeof roles.resolveEntityRole>[2]
>;

function worldMetadata(fixture: WorldMetadataFixture): RolesWorldMetadata {
  return fixture as RolesWorldMetadata;
}

type RuntimeOverrides = {
  settings?: Record<string, string>;
  room?: unknown;
  world?: unknown;
  entities?: Record<string, Record<string, unknown>>;
};

function createRuntime(overrides: RuntimeOverrides = {}) {
  const raw = {
    agentId: AGENT_ID,
    reportError: vi.fn(),
    getSetting: vi.fn((key: string) => overrides.settings?.[key]),
    setSetting: vi.fn((_key: string, _value: string | null) => {}),
    getRoom: vi.fn(async () => overrides.room ?? null),
    getWorld: vi.fn(async () => overrides.world ?? null),
    getEntityById: vi.fn(
      async (entityId: string) => overrides.entities?.[entityId] ?? null,
    ),
    getRelationships: vi.fn(async () => [] as Array<Record<string, unknown>>),
    updateWorld: vi.fn(async (_world: unknown) => {}),
  };
  return { raw, runtime: raw as unknown as IAgentRuntime };
}

type MessageOverrides = {
  source?: string;
  metadata?: Record<string, unknown>;
  contentMetadata?: Record<string, unknown>;
};

function createMessage(
  entityId: UUID,
  overrides: MessageOverrides = {},
): Memory {
  return {
    id: MESSAGE_ID,
    roomId: ROOM_ID,
    entityId,
    content: {
      text: "check roles",
      ...(overrides.source ? { source: overrides.source } : {}),
      ...(overrides.contentMetadata
        ? { metadata: overrides.contentMetadata }
        : {}),
    },
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  } as Memory;
}

function createWorld(metadata?: Record<string, unknown>): World {
  return {
    id: WORLD_ID,
    ...(metadata ? { metadata } : {}),
  } as unknown as World;
}

describe("utils barrel wiring", () => {
  it("re-exports the exact runtime functions from @elizaos/core", () => {
    expect(roles.canModifyRole).toBe(coreCanModifyRole);
    expect(roles.checkSenderPrivateAccess).toBe(coreCheckSenderPrivateAccess);
    expect(roles.checkSenderRole).toBe(coreCheckSenderRole);
    expect(roles.getConfiguredOwnerEntityIds).toBe(
      coreGetConfiguredOwnerEntityIds,
    );
    expect(roles.getConnectorAdminWhitelist).toBe(
      coreGetConnectorAdminWhitelist,
    );
    expect(roles.getEntityRole).toBe(coreGetEntityRole);
    expect(roles.getLiveEntityMetadataFromMessage).toBe(
      coreGetLiveEntityMetadataFromMessage,
    );
    expect(roles.hasConfiguredCanonicalOwner).toBe(
      coreHasConfiguredCanonicalOwner,
    );
    expect(roles.matchEntityToConnectorAdminWhitelist).toBe(
      coreMatchEntityToConnectorAdminWhitelist,
    );
    expect(roles.normalizeRole).toBe(coreNormalizeRole);
    expect(roles.resolveCanonicalOwnerId).toBe(coreResolveCanonicalOwnerId);
    expect(roles.resolveCanonicalOwnerIdForMessage).toBe(
      coreResolveCanonicalOwnerIdForMessage,
    );
    expect(roles.resolveEntityRole).toBe(coreResolveEntityRole);
    expect(roles.resolveWorldForMessage).toBe(coreResolveWorldForMessage);
    expect(roles.setConnectorAdminWhitelist).toBe(
      coreSetConnectorAdminWhitelist,
    );
    expect(roles.setEntityRole).toBe(coreSetEntityRole);
  });
});

describe("getConfiguredOwnerEntityIds", () => {
  it("returns an empty array when no owner settings are configured", () => {
    const { runtime } = createRuntime();
    expect(roles.getConfiguredOwnerEntityIds(runtime)).toEqual([]);
  });

  it("lists the canonical owner first and dedupes owner contacts", () => {
    const { runtime } = createRuntime({
      settings: {
        [CANONICAL_OWNER_KEY]: ACTOR_ID,
        [OWNER_CONTACTS_KEY]: JSON.stringify({
          a: { entityId: OTHER_ID },
          b: {},
          c: { entityId: ACTOR_ID },
          d: { entityId: "   " },
        }),
      },
    });
    expect(roles.getConfiguredOwnerEntityIds(runtime)).toEqual([
      ACTOR_ID,
      OTHER_ID,
    ]);
  });

  it("treats whitespace-only and non-string settings as unset", () => {
    const whitespace = createRuntime({
      settings: { [CANONICAL_OWNER_KEY]: "   " },
    });
    expect(roles.getConfiguredOwnerEntityIds(whitespace.runtime)).toEqual([]);
    const nonString = {
      getSetting: () => 42,
    } as unknown as IAgentRuntime;
    expect(roles.getConfiguredOwnerEntityIds(nonString)).toEqual([]);
  });

  it("throws OWNER_CONTACTS_INVALID for malformed owner-contact JSON", () => {
    const { runtime } = createRuntime({
      settings: { [OWNER_CONTACTS_KEY]: "{not json" },
    });
    let caught: unknown;
    try {
      roles.getConfiguredOwnerEntityIds(runtime);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ElizaError);
    expect((caught as { code?: string }).code).toBe("OWNER_CONTACTS_INVALID");
  });
});

describe("hasConfiguredCanonicalOwner", () => {
  it("is true only when at least one owner id resolves", () => {
    const configured = createRuntime({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
    });
    expect(roles.hasConfiguredCanonicalOwner(configured.runtime)).toBe(true);
    const unconfigured = createRuntime();
    expect(roles.hasConfiguredCanonicalOwner(unconfigured.runtime)).toBe(false);
  });
});

describe("resolveCanonicalOwnerId", () => {
  it("prefers the configured owner over conflicting world ownership", () => {
    const { runtime } = createRuntime({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
    });
    expect(
      roles.resolveCanonicalOwnerId(runtime, {
        ownership: { ownerId: RECORDED_OWNER_ID },
      }),
    ).toBe(ACTOR_ID);
  });

  it("falls back to a valid UUID recorded on the world", () => {
    const { runtime } = createRuntime();
    expect(
      roles.resolveCanonicalOwnerId(runtime, {
        ownership: { ownerId: RECORDED_OWNER_ID },
      }),
    ).toBe(RECORDED_OWNER_ID);
  });

  it("rejects numeric legacy owner ids and missing metadata with null", () => {
    const { runtime } = createRuntime();
    expect(
      roles.resolveCanonicalOwnerId(runtime, {
        ownership: { ownerId: "424242" },
      }),
    ).toBeNull();
    expect(roles.resolveCanonicalOwnerId(runtime)).toBeNull();
  });
});

describe("setConnectorAdminWhitelist", () => {
  it("persists normalized JSON and drops empty or non-string entries", () => {
    const { runtime, raw } = createRuntime();
    roles.setConnectorAdminWhitelist(runtime, {
      discord: [],
      telegram: [" a ", "b", 42],
    });
    expect(raw.setSetting).toHaveBeenCalledTimes(1);
    expect(raw.setSetting).toHaveBeenCalledWith(
      CONNECTOR_ADMINS_KEY,
      JSON.stringify({ telegram: ["a", "b"] }),
    );
  });

  it("clears the setting with null when the whitelist normalizes to empty", () => {
    const { runtime, raw } = createRuntime();
    roles.setConnectorAdminWhitelist(runtime, undefined);
    expect(raw.setSetting).toHaveBeenCalledWith(CONNECTOR_ADMINS_KEY, null);
  });

  it("does nothing without throwing when setSetting is unavailable", () => {
    const bare = {} as IAgentRuntime;
    expect(() =>
      roles.setConnectorAdminWhitelist(bare, { telegram: ["a"] }),
    ).not.toThrow();
  });
});

describe("getConnectorAdminWhitelist", () => {
  it("returns an empty whitelist when the setting is absent", () => {
    const { runtime } = createRuntime();
    expect(roles.getConnectorAdminWhitelist(runtime)).toEqual({});
  });

  it("normalizes stored JSON by trimming values and dropping empties", () => {
    const { runtime } = createRuntime({
      settings: {
        [CONNECTOR_ADMINS_KEY]: JSON.stringify({
          discord: [" x ", "", 5],
          telegram: [],
        }),
      },
    });
    expect(roles.getConnectorAdminWhitelist(runtime)).toEqual({
      discord: ["x"],
    });
  });

  it("throws CONNECTOR_ADMINS_INVALID for malformed persisted JSON", () => {
    const { runtime } = createRuntime({
      settings: { [CONNECTOR_ADMINS_KEY]: "{broken" },
    });
    let caught: unknown;
    try {
      roles.getConnectorAdminWhitelist(runtime);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ElizaError);
    expect((caught as { code?: string }).code).toBe("CONNECTOR_ADMINS_INVALID");
  });
});

describe("matchEntityToConnectorAdminWhitelist", () => {
  it("matches on the userId stable-id field first", () => {
    expect(
      roles.matchEntityToConnectorAdminWhitelist(
        { telegram: { userId: "tg-1" } },
        { telegram: ["tg-2", "tg-1"] },
      ),
    ).toEqual({
      connector: "telegram",
      matchedField: "userId",
      matchedValue: "tg-1",
    });
  });

  it("falls back to the id field when userId does not match", () => {
    expect(
      roles.matchEntityToConnectorAdminWhitelist(
        { telegram: { userId: "other", id: "tg-9" } },
        { telegram: ["tg-9"] },
      ),
    ).toEqual({
      connector: "telegram",
      matchedField: "id",
      matchedValue: "tg-9",
    });
  });

  it("returns null for mismatched connectors, empty whitelists, and absent metadata", () => {
    expect(
      roles.matchEntityToConnectorAdminWhitelist(
        { discord: { userId: "dc-1" } },
        { telegram: ["dc-1"] },
      ),
    ).toBeNull();
    expect(
      roles.matchEntityToConnectorAdminWhitelist(
        { telegram: { userId: "tg-1" } },
        undefined,
      ),
    ).toBeNull();
    expect(
      roles.matchEntityToConnectorAdminWhitelist(null, { telegram: ["tg-1"] }),
    ).toBeNull();
  });
});

describe("normalizeRole", () => {
  it("canonicalizes known tiers case-insensitively and folds MEMBER to USER", () => {
    expect(roles.normalizeRole("owner")).toBe("OWNER");
    expect(roles.normalizeRole("Admin")).toBe("ADMIN");
    expect(roles.normalizeRole("USER")).toBe("USER");
    expect(roles.normalizeRole("MEMBER")).toBe("USER");
    expect(roles.normalizeRole("member")).toBe("USER");
  });

  it("fails closed to GUEST for unknown, padded, or absent roles", () => {
    expect(roles.normalizeRole("MODERATOR")).toBe("GUEST");
    expect(roles.normalizeRole("")).toBe("GUEST");
    expect(roles.normalizeRole(" OWNER")).toBe("GUEST");
    expect(roles.normalizeRole(null)).toBe("GUEST");
    expect(roles.normalizeRole(undefined)).toBe("GUEST");
  });
});

describe("getEntityRole", () => {
  it("normalizes the stored world role for an entity", () => {
    expect(
      roles.getEntityRole(
        worldMetadata({
          roles: { [ACTOR_ID]: "admin" },
          roleSources: { [ACTOR_ID]: "manual" },
        }),
        ACTOR_ID,
      ),
    ).toBe("ADMIN");
    expect(
      roles.getEntityRole(
        worldMetadata({ roles: { [OTHER_ID]: "MEMBER" } }),
        OTHER_ID,
      ),
    ).toBe("USER");
  });

  it("defaults to GUEST without roles, entity entry, or metadata", () => {
    expect(roles.getEntityRole(undefined, ACTOR_ID)).toBe("GUEST");
    expect(roles.getEntityRole({}, STRANGER_ID)).toBe("GUEST");
    expect(
      roles.getEntityRole(
        worldMetadata({ roles: { [OTHER_ID]: "ADMIN" } }),
        ACTOR_ID,
      ),
    ).toBe("GUEST");
  });
});

describe("getLiveEntityMetadataFromMessage", () => {
  it("returns only trusted memory-level connector identity, never content.metadata", () => {
    const message = createMessage(ACTOR_ID, {
      source: "carrier-pigeon",
      metadata: { "carrier-pigeon": { userId: "p1", id: "p1" } },
      contentMetadata: { "carrier-pigeon": { userId: "spoofed" } },
    });
    expect(roles.getLiveEntityMetadataFromMessage(message)).toEqual({
      "carrier-pigeon": { userId: "p1", id: "p1" },
    });
  });

  it("returns undefined without a message source even when metadata exists", () => {
    const message = createMessage(ACTOR_ID, {
      metadata: { "carrier-pigeon": { userId: "p1" } },
    });
    expect(roles.getLiveEntityMetadataFromMessage(message)).toBeUndefined();
  });

  it("returns undefined when the nested connector block has no stable id field", () => {
    const message = createMessage(ACTOR_ID, {
      source: "carrier-pigeon",
      metadata: { "carrier-pigeon": { name: "no stable ids here" } },
    });
    expect(roles.getLiveEntityMetadataFromMessage(message)).toBeUndefined();
  });
});

describe("resolveEntityRole", () => {
  it("resolves a directly configured canonical owner to OWNER", async () => {
    const { runtime } = createRuntime({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
    });
    expect(await roles.resolveEntityRole(runtime, null, {}, ACTOR_ID)).toBe(
      "OWNER",
    );
  });

  it("honors a manually granted stored role", async () => {
    const { runtime } = createRuntime();
    const metadata = worldMetadata({
      roles: { [ACTOR_ID]: "ADMIN" },
      roleSources: { [ACTOR_ID]: "manual" },
    });
    expect(
      await roles.resolveEntityRole(runtime, null, metadata, ACTOR_ID),
    ).toBe("ADMIN");
  });

  it("folds a sourceless stored OWNER grant to GUEST", async () => {
    const { runtime } = createRuntime();
    const metadata = worldMetadata({ roles: { [ACTOR_ID]: "OWNER" } });
    expect(
      await roles.resolveEntityRole(runtime, null, metadata, ACTOR_ID),
    ).toBe("GUEST");
  });

  it("keeps OWNER when the stored grant was made manually", async () => {
    const { runtime } = createRuntime();
    const metadata = worldMetadata({
      roles: { [ACTOR_ID]: "OWNER" },
      roleSources: { [ACTOR_ID]: "manual" },
    });
    expect(
      await roles.resolveEntityRole(runtime, null, metadata, ACTOR_ID),
    ).toBe("OWNER");
  });

  it("elevates an unknown sender to ADMIN on a live whitelist match", async () => {
    const { runtime } = createRuntime({
      settings: {
        [CONNECTOR_ADMINS_KEY]: JSON.stringify({
          "carrier-pigeon": ["p9"],
        }),
      },
    });
    expect(
      await roles.resolveEntityRole(runtime, null, {}, STRANGER_ID, {
        liveEntityMetadata: { "carrier-pigeon": { userId: "p9", id: "p9" } },
        liveEntityId: STRANGER_ID,
      }),
    ).toBe("ADMIN");
  });

  it("demotes a stale connector_admin grant when the whitelist is now empty", async () => {
    const { runtime } = createRuntime();
    const metadata = worldMetadata({
      roles: { [ACTOR_ID]: "ADMIN" },
      roleSources: { [ACTOR_ID]: "connector_admin" },
    });
    expect(
      await roles.resolveEntityRole(runtime, null, metadata, ACTOR_ID),
    ).toBe("GUEST");
  });

  it("keeps ADMIN for a connector_admin grant still backed by stored entity metadata", async () => {
    const { runtime } = createRuntime({
      settings: {
        [CONNECTOR_ADMINS_KEY]: JSON.stringify({
          "carrier-pigeon": ["p7"],
        }),
      },
      entities: {
        [ACTOR_ID]: {
          metadata: { "carrier-pigeon": { userId: "p7" } },
        },
      },
    });
    const metadata = worldMetadata({
      roles: { [ACTOR_ID]: "ADMIN" },
      roleSources: { [ACTOR_ID]: "connector_admin" },
    });
    expect(
      await roles.resolveEntityRole(runtime, null, metadata, ACTOR_ID),
    ).toBe("ADMIN");
  });

  it("fails closed to GUEST when a connector_admin grant no longer matches", async () => {
    const { runtime } = createRuntime({
      settings: {
        [CONNECTOR_ADMINS_KEY]: JSON.stringify({
          "carrier-pigeon": ["someone-else"],
        }),
      },
    });
    const metadata = worldMetadata({
      roles: { [ACTOR_ID]: "ADMIN" },
      roleSources: { [ACTOR_ID]: "connector_admin" },
    });
    expect(
      await roles.resolveEntityRole(runtime, null, metadata, ACTOR_ID),
    ).toBe("GUEST");
  });

  it("stays GUEST for an ungranted sender against an empty whitelist", async () => {
    const { runtime } = createRuntime();
    expect(await roles.resolveEntityRole(runtime, null, {}, STRANGER_ID)).toBe(
      "GUEST",
    );
  });

  it("propagates ROLE_ENTITY_LOOKUP_FAILED instead of degrading to GUEST", async () => {
    const failure = new Error("db down");
    const raw = {
      agentId: AGENT_ID,
      reportError: vi.fn(),
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => {
        throw failure;
      }),
    };
    const runtime = raw as unknown as IAgentRuntime;
    const metadata = worldMetadata({ roles: { [ACTOR_ID]: "USER" } });
    const caught = await roles
      .resolveEntityRole(runtime, null, metadata, ACTOR_ID)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ElizaError);
    expect((caught as { code?: string }).code).toBe(
      "ROLE_ENTITY_LOOKUP_FAILED",
    );
    expect((caught as { cause?: unknown }).cause).toBe(failure);
    expect(raw.reportError).toHaveBeenCalledWith(
      "Roles.getEntityMetadata",
      failure,
      expect.objectContaining({ entityId: ACTOR_ID }),
    );
  });

  it("propagates CONNECTOR_ADMINS_INVALID while probing a stored role", async () => {
    const { runtime } = createRuntime({
      settings: { [CONNECTOR_ADMINS_KEY]: "{broken" },
      entities: { [ACTOR_ID]: {} },
    });
    const metadata = worldMetadata({ roles: { [ACTOR_ID]: "USER" } });
    const caught = await roles
      .resolveEntityRole(runtime, null, metadata, ACTOR_ID)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ElizaError);
    expect((caught as { code?: string }).code).toBe("CONNECTOR_ADMINS_INVALID");
  });
});

describe("resolveWorldForMessage", () => {
  it("resolves the room's world and returns its metadata", async () => {
    const world = createWorld({ roles: { [OTHER_ID]: "USER" } });
    const { runtime, raw } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world,
    });
    const resolved = await roles.resolveWorldForMessage(
      runtime,
      createMessage(ACTOR_ID),
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.world).toBe(world);
    expect(resolved?.metadata).toEqual({ roles: { [OTHER_ID]: "USER" } });
    expect(raw.getWorld).toHaveBeenCalledWith(WORLD_ID);
  });

  it("returns null when the room has no world id and never loads a world", async () => {
    const { runtime, raw } = createRuntime({ room: { id: ROOM_ID } });
    const resolved = await roles.resolveWorldForMessage(
      runtime,
      createMessage(ACTOR_ID),
    );
    expect(resolved).toBeNull();
    expect(raw.getWorld).not.toHaveBeenCalled();
  });

  it("returns null when there is no room", async () => {
    const { runtime } = createRuntime();
    const resolved = await roles.resolveWorldForMessage(
      runtime,
      createMessage(ACTOR_ID),
    );
    expect(resolved).toBeNull();
  });

  it("returns null when the resolved world does not exist", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: null,
    });
    const resolved = await roles.resolveWorldForMessage(
      runtime,
      createMessage(ACTOR_ID),
    );
    expect(resolved).toBeNull();
  });

  it("defaults missing world metadata to an empty object", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: createWorld(),
    });
    const resolved = await roles.resolveWorldForMessage(
      runtime,
      createMessage(ACTOR_ID),
    );
    expect(resolved?.metadata).toEqual({});
  });
});

describe("resolveCanonicalOwnerIdForMessage", () => {
  it("returns the actor id when the actor is a configured owner", async () => {
    const { runtime } = createRuntime({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
    });
    expect(
      await roles.resolveCanonicalOwnerIdForMessage(
        runtime,
        createMessage(ACTOR_ID),
      ),
    ).toBe(ACTOR_ID);
  });

  it("returns the first configured owner for any other actor", async () => {
    const { runtime } = createRuntime({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
    });
    expect(
      await roles.resolveCanonicalOwnerIdForMessage(
        runtime,
        createMessage(STRANGER_ID),
      ),
    ).toBe(ACTOR_ID);
  });

  it("falls back to the world-recorded owner without configuration", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: createWorld({ ownership: { ownerId: RECORDED_OWNER_ID } }),
    });
    expect(
      await roles.resolveCanonicalOwnerIdForMessage(
        runtime,
        createMessage(STRANGER_ID),
      ),
    ).toBe(RECORDED_OWNER_ID);
  });

  it("returns null when neither configuration nor a world resolves an owner", async () => {
    const { runtime } = createRuntime();
    expect(
      await roles.resolveCanonicalOwnerIdForMessage(
        runtime,
        createMessage(STRANGER_ID),
      ),
    ).toBeNull();
  });

  it("returns the actor id when connector identity proves the actor owns the world under a different UUID", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: createWorld({ ownership: { ownerId: RECORDED_OWNER_ID } }),
      entities: {
        [RECORDED_OWNER_ID]: {
          metadata: {
            "carrier-pigeon": { userId: "p1", id: "p1" },
          },
        },
      },
    });
    const message = createMessage(STRANGER_ID, {
      source: "carrier-pigeon",
      metadata: { "carrier-pigeon": { userId: "p1", id: "p1" } },
    });
    expect(
      await roles.resolveCanonicalOwnerIdForMessage(runtime, message),
    ).toBe(STRANGER_ID);
  });
});

describe("checkSenderRole", () => {
  it("reports the normalized role and its gate flags for a stored admin", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: createWorld({
        roles: { [STRANGER_ID]: "admin" },
        roleSources: { [STRANGER_ID]: "manual" },
      }),
    });
    const result = await roles.checkSenderRole(
      runtime,
      createMessage(STRANGER_ID),
    );
    expect(result).toEqual({
      entityId: STRANGER_ID,
      role: "ADMIN",
      isOwner: false,
      isAdmin: true,
      canManageRoles: true,
    });
  });

  it("returns null when the message's world cannot be resolved", async () => {
    const { runtime } = createRuntime();
    expect(
      await roles.checkSenderRole(runtime, createMessage(ACTOR_ID)),
    ).toBeNull();
  });
});

describe("checkSenderPrivateAccess", () => {
  it("marks a canonical owner with full private access sourced from owner", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: createWorld(),
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
    });
    const result = await roles.checkSenderPrivateAccess(
      runtime,
      createMessage(ACTOR_ID),
    );
    expect(result).toMatchObject({
      entityId: ACTOR_ID,
      role: "OWNER",
      isOwner: true,
      isAdmin: true,
      canManageRoles: true,
      hasPrivateAccess: true,
      accessRole: "OWNER",
      accessSource: "owner",
    });
  });

  it("grants private access for a manual stored grant and records its source", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: createWorld({
        roles: { [STRANGER_ID]: "USER" },
        roleSources: { [STRANGER_ID]: "manual" },
      }),
    });
    const result = await roles.checkSenderPrivateAccess(
      runtime,
      createMessage(STRANGER_ID),
    );
    expect(result).toMatchObject({
      entityId: STRANGER_ID,
      role: "USER",
      isOwner: false,
      isAdmin: false,
      canManageRoles: false,
      hasPrivateAccess: true,
      accessRole: "USER",
      accessSource: "manual",
    });
  });

  it("denies private access for an ungranted stranger", async () => {
    const { runtime } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world: createWorld(),
    });
    const result = await roles.checkSenderPrivateAccess(
      runtime,
      createMessage(STRANGER_ID),
    );
    expect(result).toMatchObject({
      entityId: STRANGER_ID,
      role: "GUEST",
      isOwner: false,
      isAdmin: false,
      canManageRoles: false,
      hasPrivateAccess: false,
      accessRole: null,
      accessSource: null,
    });
  });

  it("returns null when the message's world cannot be resolved", async () => {
    const { runtime } = createRuntime();
    expect(
      await roles.checkSenderPrivateAccess(runtime, createMessage(ACTOR_ID)),
    ).toBeNull();
  });
});

describe("canModifyRole", () => {
  it("lets an OWNER change anyone to anything different", () => {
    expect(roles.canModifyRole("OWNER", "ADMIN", "USER")).toBe(true);
    expect(roles.canModifyRole("OWNER", "GUEST", "ADMIN")).toBe(true);
  });

  it("rejects a no-op change even from the OWNER", () => {
    expect(roles.canModifyRole("OWNER", "OWNER", "OWNER")).toBe(false);
    expect(roles.canModifyRole("ADMIN", "USER", "USER")).toBe(false);
  });

  it("lets an ADMIN manage strictly lower ranks but never grant OWNER", () => {
    expect(roles.canModifyRole("ADMIN", "USER", "ADMIN")).toBe(true);
    expect(roles.canModifyRole("ADMIN", "USER", "GUEST")).toBe(true);
    expect(roles.canModifyRole("ADMIN", "USER", "OWNER")).toBe(false);
    expect(roles.canModifyRole("ADMIN", "ADMIN", "USER")).toBe(false);
    expect(roles.canModifyRole("ADMIN", "OWNER", "USER")).toBe(false);
  });

  it("denies USER and GUEST actors outright", () => {
    expect(roles.canModifyRole("USER", "GUEST", "USER")).toBe(false);
    expect(roles.canModifyRole("GUEST", "GUEST", "USER")).toBe(false);
  });
});

describe("setEntityRole", () => {
  it("writes the role plus source, persists via updateWorld once, and returns a copy", async () => {
    const world = createWorld(worldMetadata({ roles: { [OTHER_ID]: "USER" } }));
    const { runtime, raw } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world,
    });
    const result = await roles.setEntityRole(
      runtime,
      createMessage(ACTOR_ID),
      STRANGER_ID,
      "ADMIN",
    );
    expect(result).toEqual({ [OTHER_ID]: "USER", [STRANGER_ID]: "ADMIN" });
    expect(raw.updateWorld).toHaveBeenCalledTimes(1);
    expect(raw.updateWorld.mock.calls[0][0]).toBe(world);
    const persistedMetadata = (world as { metadata: WorldMetadataFixture })
      .metadata;
    expect(persistedMetadata.roles).toEqual({
      [OTHER_ID]: "USER",
      [STRANGER_ID]: "ADMIN",
    });
    expect(persistedMetadata.roleSources).toEqual({
      [STRANGER_ID]: "manual",
    });
  });

  it("removes the recorded source when demoting an entity to GUEST", async () => {
    const world = createWorld({
      roles: { [STRANGER_ID]: "ADMIN" },
      roleSources: { [STRANGER_ID]: "manual" },
    });
    const { runtime, raw } = createRuntime({
      room: { id: ROOM_ID, worldId: WORLD_ID },
      world,
    });
    const result = await roles.setEntityRole(
      runtime,
      createMessage(ACTOR_ID),
      STRANGER_ID,
      "GUEST",
    );
    expect(result[STRANGER_ID]).toBe("GUEST");
    const persistedMetadata = (world as { metadata: WorldMetadataFixture })
      .metadata;
    expect(persistedMetadata.roles?.[STRANGER_ID]).toBe("GUEST");
    expect(persistedMetadata.roleSources).not.toHaveProperty(STRANGER_ID);
    expect(raw.updateWorld).toHaveBeenCalledTimes(1);
  });

  it("rejects before updateWorld when the world cannot be resolved", async () => {
    const { runtime, raw } = createRuntime();
    await expect(
      roles.setEntityRole(
        runtime,
        createMessage(ACTOR_ID),
        STRANGER_ID,
        "ADMIN",
      ),
    ).rejects.toThrow("Cannot resolve world for role assignment");
    expect(raw.updateWorld).not.toHaveBeenCalled();
  });
});
