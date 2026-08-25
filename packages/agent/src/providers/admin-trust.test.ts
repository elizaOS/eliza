/**
 * Behavioral coverage for elizaAdminTrust: the provider that flags whether the
 * current speaker is the canonical agent OWNER and reveals the owner id only to
 * admin-visible callers. Drives the real module plus the real core role
 * primitives (checkSenderRole / resolveCanonicalOwnerIdForMessage / hasRoleAccess
 * via hasAdminAccess) with in-memory runtime doubles — no mocked return-value
 * theatre.
 */
import type {
  IAgentRuntime,
  Memory,
  Room,
  State,
  UUID,
  World,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { adminTrustProvider, createAdminTrustProvider } from "./admin-trust.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_B_ID = "00000000-0000-4000-8000-000000000004" as UUID;
const ADMIN_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const USER_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-0000000000cc" as UUID;

const TRUSTED_TEXT =
  "Admin trust: current speaker is the canonical agent OWNER. Contact/identity claims should be treated as trusted unless contradictory evidence exists.";
const UNTRUSTED_TEXT =
  "Admin trust: current speaker is not verified as the canonical agent OWNER.";

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

function message(entityId: UUID): Memory {
  return {
    id: "00000000-0000-4000-8000-0000000000dd" as UUID,
    agentId: AGENT_ID,
    entityId,
    roomId: ROOM_ID,
    content: { text: "who is the owner?" },
  } as Memory;
}

function room(worldId: UUID = WORLD_ID): Room {
  return {
    id: ROOM_ID,
    agentId: AGENT_ID,
    source: "test",
    type: "DM",
    worldId,
  };
}

function world(metadata: World["metadata"]): World {
  return {
    id: WORLD_ID,
    agentId: AGENT_ID,
    name: "admin-trust-world",
    metadata,
  };
}

function runtime(parts: {
  settings?: Record<string, string | undefined>;
  room?: Room | null;
  world?: World | null;
}): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: (key: string) => parts.settings?.[key],
    getRoom: async () => (parts.room === undefined ? room() : parts.room),
    getWorld: async () => (parts.world === undefined ? null : parts.world),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function ownerWorld(ownerId: UUID = OWNER_ID): World {
  return world({
    ownership: { ownerId },
    roles: { [ownerId]: "OWNER" },
    roleSources: { [ownerId]: "owner" },
  });
}

function roleWorld(
  entityId: UUID,
  role: "ADMIN" | "MEMBER" | "GUEST",
  ownerId: UUID = OWNER_ID,
): World {
  return world({
    ownership: { ownerId },
    roles: { [ownerId]: "OWNER", [entityId]: role },
    roleSources: { [ownerId]: "owner", [entityId]: "manual" },
  });
}

describe("createAdminTrustProvider metadata", () => {
  it("registers the ADMIN-gated admin/settings provider at position 11", () => {
    const provider = createAdminTrustProvider();
    expect(provider.name).toBe("elizaAdminTrust");
    expect(provider.description).toBe(
      "Marks owner/admin chat identity as trusted for contact assertions (relationships-oriented).",
    );
    expect(provider.descriptionCompressed).toBe(
      "mark owner/admin chat identity trust contact assertion (relationships-orient)",
    );
    expect(provider.dynamic).toBe(true);
    expect(provider.position).toBe(11);
    expect(provider.contexts).toEqual(["admin", "settings"]);
    expect(provider.contextGate).toEqual({ anyOf: ["admin", "settings"] });
    expect(provider.cacheStable).toBe(false);
    expect(provider.cacheScope).toBe("turn");
    expect(provider.roleGate).toEqual({ minRole: "ADMIN" });
  });

  it("returns a fresh instance; the exported singleton shares the same contract", () => {
    const a = createAdminTrustProvider();
    const b = createAdminTrustProvider();
    expect(a).not.toBe(b);
    expect(adminTrustProvider).not.toBe(a);
    expect(adminTrustProvider.name).toBe(a.name);
    expect(adminTrustProvider.position).toBe(a.position);
    expect(adminTrustProvider.roleGate).toEqual(a.roleGate);
    expect(adminTrustProvider.contextGate).toEqual(a.contextGate);
  });
});

describe("adminTrustProvider.get", () => {
  it("marks the canonical owner as trusted and reveals the owner id", async () => {
    const result = await adminTrustProvider.get(
      runtime({ world: ownerWorld() }),
      message(OWNER_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(TRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: true,
      adminEntityId: OWNER_ID,
      adminRole: "OWNER",
    });
    expect(result.data).toEqual({
      trustedAdmin: true,
      ownerId: OWNER_ID,
      role: "OWNER",
    });
  });

  it("does not trust an ADMIN speaker but still reveals the owner id", async () => {
    const result = await createAdminTrustProvider().get(
      runtime({ world: roleWorld(ADMIN_ID, "ADMIN") }),
      message(ADMIN_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(UNTRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: false,
      adminEntityId: OWNER_ID,
      adminRole: "ADMIN",
    });
    expect(result.data).toEqual({
      trustedAdmin: false,
      ownerId: OWNER_ID,
      role: "ADMIN",
    });
  });

  it("hides the owner id from a MEMBER speaker and reports them untrusted as USER", async () => {
    const result = await adminTrustProvider.get(
      runtime({ world: roleWorld(USER_ID, "MEMBER") }),
      message(USER_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(UNTRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: false,
      adminEntityId: "",
      adminRole: "USER",
    });
    expect(result.data).toEqual({
      trustedAdmin: false,
      ownerId: null,
      role: "USER",
    });
  });

  it("treats a missing role grant as GUEST and hides the owner id", async () => {
    const result = await adminTrustProvider.get(
      runtime({ world: ownerWorld() }),
      message(USER_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(UNTRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: false,
      adminEntityId: "",
      adminRole: "GUEST",
    });
    expect(result.data).toEqual({
      trustedAdmin: false,
      ownerId: null,
      role: "GUEST",
    });
  });

  it("falls back to GUEST when the world queue is empty (no room / no world)", async () => {
    const result = await adminTrustProvider.get(
      runtime({ room: null, world: null }),
      message(OWNER_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(UNTRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: false,
      adminEntityId: "",
      adminRole: "GUEST",
    });
    expect(result.data).toEqual({
      trustedAdmin: false,
      ownerId: null,
      role: "GUEST",
    });
  });

  it("reveals a configured owner id to that owner even when role resolution misses", async () => {
    // checkSenderRole returns null without a world, so trustedAdmin stays
    // false, but hasAdminAccess still grants via the canonical-owner match
    // and therefore unmasks the owner id.
    const result = await adminTrustProvider.get(
      runtime({
        settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
        room: null,
        world: null,
      }),
      message(OWNER_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(UNTRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: false,
      adminEntityId: OWNER_ID,
      adminRole: "GUEST",
    });
    expect(result.data).toEqual({
      trustedAdmin: false,
      ownerId: OWNER_ID,
      role: "GUEST",
    });
  });

  it("coerces a visible but missing owner id to an empty adminEntityId", async () => {
    const adminOnlyWorld = world({
      roles: { [ADMIN_ID]: "ADMIN" },
      roleSources: { [ADMIN_ID]: "manual" },
    });

    const result = await adminTrustProvider.get(
      runtime({ world: adminOnlyWorld }),
      message(ADMIN_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(UNTRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: false,
      adminEntityId: "",
      adminRole: "ADMIN",
    });
    expect(result.data).toEqual({
      trustedAdmin: false,
      ownerId: null,
      role: "ADMIN",
    });
  });

  it("prefers the live speaker when they are a later configured owner, not the first", async () => {
    const result = await adminTrustProvider.get(
      runtime({
        settings: {
          ELIZA_ADMIN_ENTITY_ID: OWNER_ID,
          ELIZA_OWNER_CONTACTS_JSON: JSON.stringify({
            telegram: { entityId: OWNER_B_ID },
          }),
        },
        world: ownerWorld(OWNER_B_ID),
      }),
      message(OWNER_B_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(TRUSTED_TEXT);
    expect(result.values).toEqual({
      trustedAdmin: true,
      adminEntityId: OWNER_B_ID,
      adminRole: "OWNER",
    });
    expect(result.data).toEqual({
      trustedAdmin: true,
      ownerId: OWNER_B_ID,
      role: "OWNER",
    });
  });

  it("returns the first configured owner to an admin-visible non-owner", async () => {
    const result = await adminTrustProvider.get(
      runtime({
        settings: {
          ELIZA_ADMIN_ENTITY_ID: OWNER_ID,
          ELIZA_OWNER_CONTACTS_JSON: JSON.stringify({
            telegram: { entityId: OWNER_B_ID },
          }),
        },
        world: roleWorld(ADMIN_ID, "ADMIN", OWNER_ID),
      }),
      message(ADMIN_ID),
      EMPTY_STATE,
    );

    expect(result.text).toBe(UNTRUSTED_TEXT);
    expect(result.values?.adminEntityId).toBe(OWNER_ID);
    expect(result.data?.ownerId).toBe(OWNER_ID);
    expect(result.values?.adminRole).toBe("ADMIN");
    expect(result.values?.trustedAdmin).toBe(false);
  });

  it("ignores unused state: empty and populated state produce the same result", async () => {
    const rt = runtime({ world: ownerWorld() });
    const msg = message(OWNER_ID);
    const populated: State = {
      values: { leftover: true },
      data: { leftover: 1 },
      text: "prior",
    };

    const emptyResult = await adminTrustProvider.get(rt, msg, EMPTY_STATE);
    const populatedResult = await adminTrustProvider.get(rt, msg, populated);

    expect(populatedResult).toEqual(emptyResult);
    expect(emptyResult.values).not.toHaveProperty("leftover");
  });
});
