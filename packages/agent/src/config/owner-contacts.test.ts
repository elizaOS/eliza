/**
 * Behavioral coverage for owner-contact source resolution, config load, and
 * routing-hint enrichment. Drives the real module with in-memory runtime
 * doubles and on-disk config files — no mocked return-value theatre.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IAgentRuntime,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  resolveOwnerContactSource,
  resolveOwnerContactWithFallback,
  resolveScopedSendSource,
} from "./owner-contacts.ts";
import type { OwnerContactsConfig } from "./types.agent-defaults.ts";

const OWNER = "11111111-1111-4111-8111-111111111111" as UUID;
const OTHER = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM_A = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM_B = "44444444-4444-4444-8444-444444444444" as UUID;

type RuntimeLike = Pick<
  IAgentRuntime,
  | "getService"
  | "getEntityById"
  | "getRoomsForParticipant"
  | "getMemoriesByRoomIds"
>;

function runtime(parts: RuntimeLike): RuntimeLike {
  return parts;
}

function memory(partial: {
  entityId: UUID;
  roomId: UUID | number;
  createdAt?: number | null;
}): Memory {
  return {
    entityId: partial.entityId,
    roomId: partial.roomId as UUID,
    createdAt: partial.createdAt === null ? undefined : partial.createdAt,
    content: { text: "owner-message" },
  };
}

describe("resolveScopedSendSource", () => {
  const handlers = new Set(["discord", "telegram", "telegram-account"]);
  const has = (source: string) => handlers.has(source);

  it("trims whitespace before matching a registered handler", () => {
    expect(resolveScopedSendSource("  discord  ", has)).toBe("discord");
  });

  it("an empty or whitespace key is an empty queue and returns the trimmed key", () => {
    expect(resolveScopedSendSource("", has)).toBe("");
    expect(resolveScopedSendSource("   ", has)).toBe("");
  });

  it("walks hyphen boundaries from longest prefix down to a registered handler", () => {
    expect(resolveScopedSendSource("discord-nubs-test-backup", has)).toBe(
      "discord",
    );
  });

  it("does not treat a non-hyphen substring as a handler prefix", () => {
    expect(resolveScopedSendSource("discordnubs", has)).toBe("discordnubs");
  });

  it("returns the full key when no hyphen-boundary prefix is registered", () => {
    expect(resolveScopedSendSource("matrix-room-a", has)).toBe("matrix-room-a");
  });
});

describe("resolveOwnerContactSource", () => {
  const discord = { entityId: OWNER, channelId: "chan-d" };
  const telegram = { entityId: OWNER, channelId: "chan-t" };
  const telegramAccount = { entityId: OWNER, channelId: "chan-ta" };

  it("returns null for a missing item, empty queue, and non-string source", () => {
    expect(resolveOwnerContactSource({}, "discord")).toBeNull();
    expect(resolveOwnerContactSource({ discord }, null)).toBeNull();
    expect(resolveOwnerContactSource({ discord }, undefined)).toBeNull();
    expect(resolveOwnerContactSource({ discord }, "")).toBeNull();
    expect(resolveOwnerContactSource({ discord }, "   ")).toBeNull();
    expect(
      resolveOwnerContactSource({ discord }, 12 as unknown as string),
    ).toBeNull();
  });

  it("resolves a single configured source after trimming", () => {
    expect(resolveOwnerContactSource({ discord }, "  discord  ")).toEqual({
      source: "discord",
      contact: discord,
    });
  });

  it("telegram candidates try telegram, then telegram-account, then telegramAccount", () => {
    expect(resolveOwnerContactSource({ telegram }, "telegram")).toEqual({
      source: "telegram",
      contact: telegram,
    });

    expect(
      resolveOwnerContactSource(
        { "telegram-account": telegramAccount },
        "telegram",
      ),
    ).toEqual({ source: "telegram-account", contact: telegramAccount });

    expect(resolveOwnerContactSource({ telegramAccount }, "telegram")).toEqual({
      source: "telegram-account",
      contact: telegramAccount,
    });
  });

  it("telegram-account candidates try the hyphenated key before camelCase and telegram", () => {
    const contacts: OwnerContactsConfig = {
      telegram,
      "telegram-account": telegramAccount,
      telegramAccount: { entityId: OTHER },
    };
    expect(resolveOwnerContactSource(contacts, "telegram-account")).toEqual({
      source: "telegram-account",
      contact: telegramAccount,
    });
  });

  it("telegramAccount candidates try camelCase first, then hyphenated, then telegram", () => {
    const contacts: OwnerContactsConfig = {
      telegram,
      "telegram-account": telegramAccount,
      telegramAccount: { entityId: OTHER, channelId: "camel" },
    };
    expect(resolveOwnerContactSource(contacts, "telegramAccount")).toEqual({
      source: "telegram-account",
      contact: contacts.telegramAccount,
    });
  });

  it("canonicalizes a camelCase telegramAccount hit to telegram-account", () => {
    expect(
      resolveOwnerContactSource(
        { telegramAccount: { entityId: OWNER } },
        "telegramAccount",
      ),
    ).toEqual({
      source: "telegram-account",
      contact: { entityId: OWNER },
    });
  });
});

describe("resolveOwnerContactWithFallback", () => {
  const discord = { entityId: OWNER };

  it("prefers a configured contact over the owner-entity fallback", () => {
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: { discord },
        source: "discord",
        ownerEntityId: OTHER,
      }),
    ).toEqual({
      source: "discord",
      contact: discord,
      resolvedFrom: "config",
    });
  });

  it("falls back to the owner entity for client_chat and discord when config misses", () => {
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: MESSAGE_SOURCE_CLIENT_CHAT,
        ownerEntityId: `  ${OWNER}  `,
      }),
    ).toEqual({
      source: MESSAGE_SOURCE_CLIENT_CHAT,
      contact: { entityId: OWNER },
      resolvedFrom: "owner_entity",
    });

    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: "discord",
        ownerEntityId: OWNER,
      }),
    ).toEqual({
      source: "discord",
      contact: { entityId: OWNER },
      resolvedFrom: "owner_entity",
    });
  });

  it("does not invent a fallback for telegram, missing source, or missing owner entity", () => {
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: "telegram",
        ownerEntityId: OWNER,
      }),
    ).toBeNull();
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: "discord",
        ownerEntityId: "   ",
      }),
    ).toBeNull();
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: "discord",
        ownerEntityId: null,
      }),
    ).toBeNull();
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: "discord",
        ownerEntityId: undefined,
      }),
    ).toBeNull();
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: "",
        ownerEntityId: OWNER,
      }),
    ).toBeNull();
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: null,
        ownerEntityId: OWNER,
      }),
    ).toBeNull();
    expect(
      resolveOwnerContactWithFallback({
        ownerContacts: {},
        source: "discord",
        ownerEntityId: 7 as unknown as string,
      }),
    ).toBeNull();
  });
});

describe("loadOwnerContactsConfig", () => {
  const originalEnv = { ...process.env };
  const roots: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function isolateConfig(body: string): void {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-owner-contacts-"),
    );
    roots.push(root);
    const configPath = path.join(root, "eliza.json");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, body);
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_STATE_DIR = stateDir;
    delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  }

  const loadContext = {
    boundary: "owner_contacts",
    operation: "test_load",
    message: "[owner-contacts] test load failed",
  };

  it("returns configured owner contacts from a real eliza.json", () => {
    isolateConfig(
      JSON.stringify({
        agents: {
          defaults: {
            ownerContacts: {
              discord: { entityId: OWNER, channelId: "c1" },
            },
          },
        },
      }),
    );

    expect(loadOwnerContactsConfig(loadContext)).toEqual({
      discord: { entityId: OWNER, channelId: "c1" },
    });
  });

  it("returns an empty map when agents.defaults.ownerContacts is absent", () => {
    isolateConfig(JSON.stringify({ agents: { defaults: {} } }));
    expect(loadOwnerContactsConfig(loadContext)).toEqual({});
  });

  it("returns an empty map when loadElizaConfig throws on invalid JSON", () => {
    isolateConfig("{ this is not json");
    expect(loadOwnerContactsConfig(loadContext)).toEqual({});
  });
});

describe("loadOwnerContactRoutingHints", () => {
  it("returns an empty map for an empty owner-contacts queue", async () => {
    expect(await loadOwnerContactRoutingHints(null, {})).toEqual({});
    expect(await loadOwnerContactRoutingHints(undefined, {})).toEqual({});
  });

  it("emits config-only hints when runtime or entity id is missing", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { channelId: "c-static", roomId: "r-static" },
    };
    expect(await loadOwnerContactRoutingHints(null, ownerContacts)).toEqual({
      discord: {
        source: "discord",
        entityId: null,
        channelId: "c-static",
        roomId: "r-static",
        preferredCommunicationChannel: null,
        platformIdentities: [],
        lastResponseAt: null,
        lastResponseChannel: null,
        resolvedFrom: "config",
      },
    });
  });

  it("ignores a relationships service that is not getContact-shaped", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER },
    };
    const rt = runtime({
      getService: () => ({ notGetContact: true }) as never,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });
    const hints = await loadOwnerContactRoutingHints(rt, ownerContacts);
    expect(hints.discord?.resolvedFrom).toBe("config");
    expect(hints.discord?.entityId).toBe(OWNER);
  });

  it("enriches from relationships using source-prefixed custom fields first", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER, channelId: "old-chan", roomId: "old-room" },
    };
    const rt = runtime({
      getService: () =>
        ({
          getContact: async () => ({
            preferences: { preferredCommunicationChannel: "  telegram  " },
            customFields: {
              discordChannelId: "  new-chan  ",
              discordchannelId: "ignored-chan",
              channelId: "generic-chan",
              discordRoomId: "new-room",
              discordroomId: "ignored-room",
              roomId: "generic-room",
              discordEntityId: OTHER,
              discordentityId: OWNER,
              entityId: OWNER,
            },
          }),
        }) as never,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });

    const hints = await loadOwnerContactRoutingHints(rt, ownerContacts);
    expect(hints.discord).toMatchObject({
      entityId: OTHER,
      channelId: "new-chan",
      roomId: "new-room",
      preferredCommunicationChannel: "telegram",
      resolvedFrom: "config+relationships",
    });
    expect(ownerContacts.discord?.entityId).toBe(OTHER);
    expect(ownerContacts.discord?.channelId).toBe("new-chan");
    expect(ownerContacts.discord?.roomId).toBe("new-room");
  });

  it("falls through custom-field aliases and skips blank or missing keys", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER },
    };
    const rt = runtime({
      getService: () =>
        ({
          getContact: async () => ({
            customFields: {
              discordChannelId: "   ",
              discordchannelId: "alt-chan",
              discordRoomId: "",
              discordroomId: "   ",
              roomId: "generic-room",
            },
          }),
        }) as never,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });

    const hints = await loadOwnerContactRoutingHints(rt, ownerContacts);
    expect(hints.discord?.channelId).toBe("alt-chan");
    expect(hints.discord?.roomId).toBe("generic-room");
    expect(hints.discord?.entityId).toBe(OWNER);
    expect(hints.discord?.resolvedFrom).toBe("config+relationships");
  });

  it("keeps static config when getContact returns null or throws", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER, channelId: "static" },
    };
    const nullRt = runtime({
      getService: () =>
        ({
          getContact: async () => null,
        }) as never,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });
    const throwRt = runtime({
      getService: () =>
        ({
          getContact: async () => {
            throw new Error("relationships down");
          },
        }) as never,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });

    const fromNull = await loadOwnerContactRoutingHints(nullRt, ownerContacts);
    const fromThrow = await loadOwnerContactRoutingHints(
      throwRt,
      ownerContacts,
    );
    expect(fromNull.discord?.resolvedFrom).toBe("config");
    expect(fromNull.discord?.channelId).toBe("static");
    expect(fromThrow.discord?.resolvedFrom).toBe("config");
    expect(fromThrow.discord?.channelId).toBe("static");
  });

  it("normalizes platform identities and drops incomplete entries", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER },
    };
    const rt = runtime({
      getService: () => null,
      getEntityById: async () =>
        ({
          id: OWNER,
          names: ["owner"],
          agentId: OWNER,
          metadata: {
            platformIdentities: [
              { platform: "  discord  ", handle: "  nubs  ", status: "  ok  " },
              { platform: "telegram", handle: "nubs" },
              { platform: "discord", handle: "   " },
              { platform: "", handle: "nubs" },
              { platform: "x", handle: "nubs", status: "   " },
              null,
              "not-an-object",
              12,
            ],
          },
        }) as Awaited<ReturnType<IAgentRuntime["getEntityById"]>>,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });

    const hints = await loadOwnerContactRoutingHints(rt, ownerContacts);
    expect(hints.discord?.platformIdentities).toEqual([
      { platform: "discord", handle: "nubs", status: "ok" },
      { platform: "telegram", handle: "nubs" },
      { platform: "x", handle: "nubs" },
    ]);
  });

  it("keeps going when entity lookup throws or identities are not an array", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER },
    };
    const throwRt = runtime({
      getService: () => null,
      getEntityById: async () => {
        throw new Error("entity missing");
      },
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });
    const badMetaRt = runtime({
      getService: () => null,
      getEntityById: async () =>
        ({
          id: OWNER,
          names: ["owner"],
          agentId: OWNER,
          metadata: { platformIdentities: { not: "array" } },
        }) as Awaited<ReturnType<IAgentRuntime["getEntityById"]>>,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => [],
    });

    expect(
      (await loadOwnerContactRoutingHints(throwRt, ownerContacts)).discord
        ?.platformIdentities,
    ).toEqual([]);
    expect(
      (await loadOwnerContactRoutingHints(badMetaRt, ownerContacts)).discord
        ?.platformIdentities,
    ).toEqual([]);
  });

  it("orders owner history newest-first and prefers roomId over channelId", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER, roomId: ROOM_A, channelId: ROOM_B },
    };
    let seenLimit: number | undefined;
    const rt = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [ROOM_A, ROOM_B],
      getMemoriesByRoomIds: async (params) => {
        seenLimit = params.limit;
        expect(params.tableName).toBe("messages");
        expect(params.roomIds).toEqual([ROOM_A, ROOM_B]);
        return [
          memory({ entityId: OWNER, roomId: ROOM_A, createdAt: 100 }),
          memory({ entityId: OWNER, roomId: ROOM_A, createdAt: 300 }),
          memory({ entityId: OWNER, roomId: ROOM_A, createdAt: 200 }),
          memory({ entityId: OTHER, roomId: ROOM_A, createdAt: 999 }),
          memory({ entityId: OWNER, roomId: ROOM_B, createdAt: 500 }),
        ];
      },
    });

    const hints = await loadOwnerContactRoutingHints(rt, ownerContacts);
    expect(seenLimit).toBe(20);
    expect(hints.discord?.lastResponseAt).toBe("300");
    expect(hints.discord?.lastResponseChannel).toBe("discord");
  });

  it("matches channelId when roomId is absent and treats missing createdAt as 0", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER, channelId: ROOM_A },
    };
    const rt = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [ROOM_A],
      getMemoriesByRoomIds: async () => [
        memory({ entityId: OWNER, roomId: ROOM_A }),
        memory({ entityId: OWNER, roomId: ROOM_A, createdAt: 50 }),
        memory({ entityId: OWNER, roomId: ROOM_A, createdAt: 50 }),
      ],
    });

    const hints = await loadOwnerContactRoutingHints(rt, ownerContacts);
    expect(hints.discord?.lastResponseAt).toBe("50");
  });

  it("does not invent last-response when neither room nor channel is set, rooms are empty, or roomId is non-string", async () => {
    const noTarget: OwnerContactsConfig = { discord: { entityId: OWNER } };
    const withRoom: OwnerContactsConfig = {
      discord: { entityId: OWNER, roomId: ROOM_A },
    };

    const emptyRooms = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [],
      getMemoriesByRoomIds: async () => {
        throw new Error("should not be called for an empty room list");
      },
    });
    const noMatch = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [ROOM_A],
      getMemoriesByRoomIds: async () => [
        memory({ entityId: OWNER, roomId: ROOM_A, createdAt: 9 }),
      ],
    });
    const nonStringRoom = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [ROOM_A],
      getMemoriesByRoomIds: async () => [
        memory({
          entityId: OWNER,
          roomId: 99 as unknown as UUID,
          createdAt: 9,
        }),
      ],
    });
    const nullCreatedAt = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [ROOM_A],
      getMemoriesByRoomIds: async () => [
        {
          entityId: OWNER,
          roomId: ROOM_A,
          createdAt: null as unknown as number,
          content: { text: "owner-message" },
        },
      ],
    });

    expect(
      (await loadOwnerContactRoutingHints(emptyRooms, withRoom)).discord
        ?.lastResponseAt,
    ).toBeNull();
    expect(
      (await loadOwnerContactRoutingHints(noMatch, noTarget)).discord
        ?.lastResponseAt,
    ).toBeNull();
    expect(
      (await loadOwnerContactRoutingHints(nonStringRoom, withRoom)).discord
        ?.lastResponseAt,
    ).toBeNull();
    expect(
      (await loadOwnerContactRoutingHints(nullCreatedAt, withRoom)).discord
        ?.lastResponseAt,
    ).toBeNull();
  });

  it("survives rooms and memory lookup failures without dropping the config hint", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER, roomId: ROOM_A },
    };
    const roomsThrow = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => {
        throw new Error("rooms failed");
      },
      getMemoriesByRoomIds: async () => [],
    });
    const memoriesThrow = runtime({
      getService: () => null,
      getEntityById: async () => null,
      getRoomsForParticipant: async () => [ROOM_A],
      getMemoriesByRoomIds: async () => {
        throw "memory store down";
      },
    });

    const fromRooms = await loadOwnerContactRoutingHints(
      roomsThrow,
      ownerContacts,
    );
    const fromMemories = await loadOwnerContactRoutingHints(
      memoriesThrow,
      ownerContacts,
    );
    expect(fromRooms.discord?.entityId).toBe(OWNER);
    expect(fromRooms.discord?.lastResponseAt).toBeNull();
    expect(fromMemories.discord?.entityId).toBe(OWNER);
    expect(fromMemories.discord?.lastResponseAt).toBeNull();
  });

  it("emits independent hints for every configured source", async () => {
    const ownerContacts: OwnerContactsConfig = {
      discord: { entityId: OWNER },
      telegram: { entityId: OTHER, channelId: "tg" },
    };
    const hints = await loadOwnerContactRoutingHints(null, ownerContacts);
    expect(Object.keys(hints).sort()).toEqual(["discord", "telegram"]);
    expect(hints.telegram?.channelId).toBe("tg");
    expect(hints.discord?.entityId).toBe(OWNER);
  });
});
