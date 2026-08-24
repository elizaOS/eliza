/**
 * Deterministic unit tests for the roles plugin bootstrap in ./index.ts.
 * Drives the real plugin `init()` against a scripted IAgentRuntime seam:
 * canonical-owner sync and demotion, connector-admin whitelist promotion and
 * stale-grant revocation, config loading precedence (direct config vs settings
 * JSON, malformed JSON), deferred bootstrap retry scheduling with its backoff
 * cap, and the WORLD_JOINED / WORLD_CONNECTED re-bootstrap hooks.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { roleAction } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rolesPlugin, { ROLE_RANK, rolesProvider } from "./index.ts";

const AGENT_ID = "99999999-9999-9999-9999-999999999999" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000020" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000010" as UUID;
const ACTOR_ID = "11111111-2222-3333-4444-555566667777" as UUID;
const OTHER_ID = "88888888-9999-aaaa-bbbb-ccccddddeeee" as UUID;
const RECORDED_OWNER_ID = "44444444-5555-6666-7777-888899990000" as UUID;
const DISCORD_MEMBER_ID = "55555555-6666-7777-8888-999900001111" as UUID;
const TELEGRAM_MEMBER_ID = "12121212-3434-5656-7878-9090a0a0b0b0" as UUID;

const CANONICAL_OWNER_KEY = "ELIZA_ADMIN_ENTITY_ID";
const CONNECTOR_ADMINS_SETTING_KEY = "ELIZA_ROLES_CONNECTOR_ADMINS_JSON";
const RETRY_TIMERS_KEY = Symbol.for("@elizaos/runtime.roles.bootstrapRetries");

type MetadataOut = {
  roles?: Record<string, string>;
  roleSources?: Record<string, string>;
  ownership?: { ownerId?: string };
};

type EventHandler = (payload?: unknown) => Promise<void>;

type HarnessOptions = {
  settings?: Record<string, string>;
  worlds?: Array<Record<string, unknown>>;
  rooms?: Array<{ id: string }>;
  entities?: Array<Record<string, unknown>>;
  worldsUnavailable?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  const worlds = (options.worlds ?? []).map((world) => structuredClone(world));
  const events = new Map<string, EventHandler>();
  const raw = {
    agentId: AGENT_ID,
    getSetting: vi.fn((key: string) => options.settings?.[key]),
    setSetting: vi.fn((_key: string, _value: string | null) => {}),
    getAllWorlds: vi.fn(async () => worlds),
    getWorld: vi.fn(async (worldId: string) =>
      options.worldsUnavailable
        ? null
        : (worlds.find((world) => world.id === worldId) ?? null),
    ),
    getRooms: vi.fn(async (_worldId: string) => options.rooms ?? []),
    getEntitiesForRoom: vi.fn(
      async (_roomId: string) => options.entities ?? [],
    ),
    updateWorld: vi.fn(async (_world: unknown) => {}),
    registerEvent: vi.fn(),
  };
  raw.registerEvent.mockImplementation(
    (event: string, handler: EventHandler) => {
      events.set(event, handler);
    },
  );
  return {
    events,
    raw,
    runtime: raw as unknown as IAgentRuntime,
    worlds,
  };
}

function retryTimers(runtime: IAgentRuntime): Map<string, unknown> {
  return (
    (runtime as unknown as Record<symbol, Map<string, unknown> | undefined>)[
      RETRY_TIMERS_KEY
    ] ?? new Map()
  );
}

type PluginConfig = Parameters<NonNullable<typeof rolesPlugin.init>>[0];

async function runInit(
  config: PluginConfig | undefined,
  runtime: IAgentRuntime,
): Promise<void> {
  const init = rolesPlugin.init;
  if (!init) throw new Error("rolesPlugin.init is required");
  await init(config ?? {}, runtime);
}

function worldFixture(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return { id: WORLD_ID, name: "Test World", metadata };
}

function lastWrittenMetadata(harness: ReturnType<typeof createHarness>) {
  const calls = harness.raw.updateWorld.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const world = calls[calls.length - 1][0] as
    | { metadata?: MetadataOut }
    | undefined;
  return world?.metadata ?? {};
}

describe("roles plugin surface", () => {
  it("exposes the roles provider and role action", () => {
    expect(rolesPlugin.name).toBe("roles");
    expect(rolesPlugin.providers).toContain(rolesProvider);
    expect(rolesPlugin.actions).toContain(roleAction);
  });

  it("ranks the role hierarchy monotonically", () => {
    expect(ROLE_RANK.GUEST).toBeGreaterThan(0);
    expect(ROLE_RANK.USER).toBeGreaterThan(ROLE_RANK.GUEST);
    expect(ROLE_RANK.ADMIN).toBeGreaterThan(ROLE_RANK.USER);
    expect(ROLE_RANK.OWNER).toBeGreaterThan(ROLE_RANK.ADMIN);
  });
});

describe("init owner bootstrap", () => {
  it("grants OWNER to the configured app user on an unclaimed world", async () => {
    const harness = createHarness({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
      worlds: [worldFixture({})],
    });
    await runInit(undefined, harness.runtime);

    expect(harness.raw.updateWorld).toHaveBeenCalledTimes(1);
    const metadata = lastWrittenMetadata(harness);
    expect(metadata.ownership?.ownerId).toBe(ACTOR_ID);
    expect(metadata.roles).toEqual({ [ACTOR_ID]: "OWNER" });
    expect(metadata.roleSources).toEqual({ [ACTOR_ID]: "owner" });
    expect(retryTimers(harness.runtime).size).toBe(0);
  });

  it("leaves an already-consistent world untouched", async () => {
    const fixture = worldFixture({
      ownership: { ownerId: ACTOR_ID },
      roles: { [ACTOR_ID]: "OWNER" },
      roleSources: { [ACTOR_ID]: "owner" },
    });
    const harness = createHarness({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
      worlds: [fixture],
    });
    await runInit(undefined, harness.runtime);

    expect(harness.raw.updateWorld).not.toHaveBeenCalled();
    expect(fixture.metadata).toEqual({
      ownership: { ownerId: ACTOR_ID },
      roles: { [ACTOR_ID]: "OWNER" },
      roleSources: { [ACTOR_ID]: "owner" },
    });
  });

  it("demotes every other OWNER once a canonical owner is configured", async () => {
    const harness = createHarness({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
      worlds: [
        worldFixture({
          roles: { [ACTOR_ID]: "OWNER", [OTHER_ID]: "OWNER" },
          roleSources: { [ACTOR_ID]: "owner", [OTHER_ID]: "owner" },
        }),
      ],
    });
    await runInit(undefined, harness.runtime);

    expect(harness.raw.updateWorld).toHaveBeenCalledTimes(1);
    const metadata = lastWrittenMetadata(harness);
    expect(metadata.roles).toEqual({ [ACTOR_ID]: "OWNER" });
    expect(metadata.roleSources).toEqual({ [ACTOR_ID]: "owner" });
  });

  it("syncs the recorded world owner without configuration and keeps other owners", async () => {
    const harness = createHarness({
      worlds: [
        worldFixture({
          ownership: { ownerId: RECORDED_OWNER_ID },
          roles: { [OTHER_ID]: "OWNER" },
        }),
      ],
    });
    await runInit(undefined, harness.runtime);

    expect(harness.raw.updateWorld).toHaveBeenCalledTimes(1);
    const metadata = lastWrittenMetadata(harness);
    expect(metadata.roles?.[RECORDED_OWNER_ID]).toBe("OWNER");
    expect(metadata.roles?.[OTHER_ID]).toBe("OWNER");
  });

  it("does nothing when no owner can be resolved", async () => {
    const harness = createHarness({ worlds: [worldFixture({})] });
    await runInit(undefined, harness.runtime);

    expect(harness.raw.updateWorld).not.toHaveBeenCalled();
  });

  it("skips worlds without an id", async () => {
    const harness = createHarness({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
      worlds: [{ name: "No Id" }],
    });
    await runInit(undefined, harness.runtime);

    expect(harness.raw.getWorld).not.toHaveBeenCalled();
    expect(harness.raw.updateWorld).not.toHaveBeenCalled();
  });

  it("survives worlds disappearing before the metadata update", async () => {
    const harness = createHarness({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
      worlds: [worldFixture({})],
      worldsUnavailable: true,
    });
    await runInit(undefined, harness.runtime);

    expect(harness.raw.updateWorld).not.toHaveBeenCalled();
  });
});

describe("init connector-admin whitelists", () => {
  const DIRECT_CONFIG = {
    connectorAdmins: { discord: ["d1"] },
  } as unknown as PluginConfig;

  function discordMember(): Record<string, unknown> {
    return {
      id: DISCORD_MEMBER_ID,
      metadata: { discord: { userId: "d1" } },
    };
  }

  it("promotes whitelisted entities to ADMIN", async () => {
    const harness = createHarness({
      worlds: [worldFixture({})],
      rooms: [{ id: ROOM_ID }],
      entities: [discordMember()],
    });
    await runInit(DIRECT_CONFIG, harness.runtime);

    expect(harness.raw.updateWorld).toHaveBeenCalledTimes(1);
    const metadata = lastWrittenMetadata(harness);
    expect(metadata.roles).toEqual({ [DISCORD_MEMBER_ID]: "ADMIN" });
    expect(metadata.roleSources).toEqual({
      [DISCORD_MEMBER_ID]: "connector_admin",
    });
  });

  it("revokes stale connector-admin grants that no longer match", async () => {
    const harness = createHarness({
      worlds: [
        worldFixture({
          roles: { [OTHER_ID]: "ADMIN" },
          roleSources: { [OTHER_ID]: "connector_admin" },
        }),
      ],
      rooms: [{ id: ROOM_ID }],
      entities: [
        discordMember(),
        { id: OTHER_ID, metadata: { discord: { userId: "gone" } } },
      ],
    });
    await runInit(DIRECT_CONFIG, harness.runtime);

    const metadata = lastWrittenMetadata(harness);
    expect(metadata.roles?.[DISCORD_MEMBER_ID]).toBe("ADMIN");
    expect(metadata.roleSources?.[DISCORD_MEMBER_ID]).toBe("connector_admin");
    expect(metadata.roles?.[OTHER_ID]).toBeUndefined();
    expect(metadata.roleSources?.[OTHER_ID]).toBeUndefined();
  });

  it("does not promote entities that already hold a role", async () => {
    const fixture = worldFixture({ roles: { [DISCORD_MEMBER_ID]: "USER" } });
    const harness = createHarness({
      worlds: [fixture],
      rooms: [{ id: ROOM_ID }],
      entities: [discordMember()],
    });
    await runInit(DIRECT_CONFIG, harness.runtime);

    expect(harness.raw.updateWorld).not.toHaveBeenCalled();
    expect(fixture.metadata).toEqual({
      roles: { [DISCORD_MEMBER_ID]: "USER" },
    });
  });

  it("loads the whitelist from the settings JSON when no direct config is given", async () => {
    const harness = createHarness({
      settings: {
        [CONNECTOR_ADMINS_SETTING_KEY]: JSON.stringify({
          telegram: ["t9"],
        }),
      },
      worlds: [worldFixture({})],
      rooms: [{ id: ROOM_ID }],
      entities: [
        {
          id: TELEGRAM_MEMBER_ID,
          metadata: { telegram: { userId: "t9" } },
        },
      ],
    });
    await runInit(undefined, harness.runtime);

    const metadata = lastWrittenMetadata(harness);
    expect(metadata.roles).toEqual({ [TELEGRAM_MEMBER_ID]: "ADMIN" });
  });

  it("treats malformed settings JSON as no whitelist and prunes stale grants", async () => {
    const harness = createHarness({
      settings: {
        [CANONICAL_OWNER_KEY]: ACTOR_ID,
        [CONNECTOR_ADMINS_SETTING_KEY]: "{not json",
      },
      worlds: [
        worldFixture({
          roles: { [ACTOR_ID]: "OWNER", [OTHER_ID]: "ADMIN" },
          roleSources: { [ACTOR_ID]: "owner", [OTHER_ID]: "connector_admin" },
        }),
      ],
    });
    await runInit(undefined, harness.runtime);

    const metadata = lastWrittenMetadata(harness);
    expect(metadata.roles?.[ACTOR_ID]).toBe("OWNER");
    expect(metadata.roles?.[OTHER_ID]).toBeUndefined();
    expect(metadata.roleSources?.[OTHER_ID]).toBeUndefined();
  });

  it("prefers direct plugin config over the settings JSON", async () => {
    const harness = createHarness({
      settings: {
        [CONNECTOR_ADMINS_SETTING_KEY]: JSON.stringify({
          telegram: ["t9"],
        }),
      },
      worlds: [worldFixture({})],
      rooms: [{ id: ROOM_ID }],
      entities: [
        discordMember(),
        {
          id: TELEGRAM_MEMBER_ID,
          metadata: { telegram: { userId: "t9" } },
        },
      ],
    });
    await runInit(DIRECT_CONFIG, harness.runtime);

    const metadata = lastWrittenMetadata(harness);
    expect(metadata.roles?.[DISCORD_MEMBER_ID]).toBe("ADMIN");
    expect(metadata.roles?.[TELEGRAM_MEMBER_ID]).toBeUndefined();
  });
});

describe("deferred bootstrap retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function failingHarness(): ReturnType<typeof createHarness> {
    const harness = createHarness({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
      worlds: [worldFixture({})],
    });
    return harness;
  }

  it("retries owner bootstrap until runtime state becomes available", async () => {
    const harness = failingHarness();
    let getAllCalls = 0;
    harness.raw.getAllWorlds.mockImplementation(async () => {
      getAllCalls += 1;
      if (getAllCalls === 1) {
        throw new Error('Failed query: select "id" from "worlds"');
      }
      return harness.worlds;
    });

    await runInit(undefined, harness.runtime);
    expect(getAllCalls).toBe(1);
    const timers = retryTimers(harness.runtime);
    expect(timers.has("Owner role bootstrap")).toBe(true);

    await vi.advanceTimersByTimeAsync(1600);
    expect(getAllCalls).toBe(2);
    expect(retryTimers(harness.runtime).has("Owner role bootstrap")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(getAllCalls).toBe(2);
    expect(harness.raw.updateWorld).toHaveBeenCalledTimes(1);
  });

  it("stops after the third failed retry", async () => {
    const harness = failingHarness();
    harness.raw.getAllWorlds.mockImplementation(async () => {
      throw new Error('Failed query: select "id" from "worlds"');
    });

    await runInit(undefined, harness.runtime);
    expect(harness.raw.getAllWorlds).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1600);
    expect(harness.raw.getAllWorlds).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3100);
    expect(harness.raw.getAllWorlds).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4600);
    expect(harness.raw.getAllWorlds).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60000);
    expect(harness.raw.getAllWorlds).toHaveBeenCalledTimes(4);
    expect(retryTimers(harness.runtime).size).toBe(0);
    expect(harness.raw.updateWorld).not.toHaveBeenCalled();
  });
});

describe("world event re-bootstrap", () => {
  it("registers WORLD_JOINED and WORLD_CONNECTED hooks", async () => {
    const harness = createHarness({});
    await runInit(undefined, harness.runtime);

    expect([...harness.events.keys()].sort()).toEqual([
      "WORLD_CONNECTED",
      "WORLD_JOINED",
    ]);
  });

  it("re-applies owner bootstrap when a connector world joins", async () => {
    const harness = createHarness({
      settings: { [CANONICAL_OWNER_KEY]: ACTOR_ID },
    });
    await runInit(undefined, harness.runtime);
    expect(harness.raw.updateWorld).not.toHaveBeenCalled();

    harness.worlds.push(worldFixture({}));
    const joined = harness.events.get("WORLD_JOINED");
    expect(joined).toBeTypeOf("function");
    await joined?.();

    expect(harness.raw.updateWorld).toHaveBeenCalledTimes(1);
    const metadata = lastWrittenMetadata(harness);
    expect(metadata.ownership?.ownerId).toBe(ACTOR_ID);
    expect(metadata.roles).toEqual({ [ACTOR_ID]: "OWNER" });

    const connected = harness.events.get("WORLD_CONNECTED");
    expect(connected).toBeTypeOf("function");
    await connected?.();
    expect(retryTimers(harness.runtime).size).toBe(0);
  });
});
