/**
 * Incident contract for GUEST-role conversation coherence (live 2026-08-09,
 * room e7a58c54: the bot answered "chat's empty" to non-admin senders).
 * Exercises the REAL basic-capabilities providers through
 * `applyPluginRoleGating` with the roles module mocked to resolve GUEST:
 * the current-room transcript (RECENT_MESSAGES), room shape (WORLD), and
 * room membership (ENTITIES) must flow to a GUEST sender, while
 * cross-platform recall (recent-conversations, ADMIN-gated) stays withheld.
 * Deterministic: the runtime is a hand-built stub over an in-memory room.
 */
import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  State,
  UUID,
} from "@elizaos/core";
import { basicProviders } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rolesMock = vi.hoisted(() => ({
  checkSenderRole: vi.fn(),
}));

vi.mock("./roles.ts", () => rolesMock);

import { recentConversationsProvider } from "../providers/recent-conversations.ts";
import { applyPluginRoleGating } from "./plugin-role-gating.ts";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ROOM_ID = "44444444-4444-4444-4444-444444444444" as UUID;
const WORLD_ID = "55555555-5555-5555-5555-555555555555" as UUID;
const GUEST_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const OTHER_ID = "66666666-6666-6666-6666-666666666666" as UUID;

function providerByName(name: string): Provider {
  const provider = basicProviders.find((p) => p.name === name);
  if (!provider) throw new Error(`basicProviders is missing ${name}`);
  return provider;
}

function roomMessage(
  id: string,
  entityId: UUID,
  entityName: string,
  text: string,
  createdAt: number,
): Memory {
  return {
    id: id as UUID,
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt,
    content: { text, source: "discord" },
    metadata: { entityName },
  } as Memory;
}

/** Busy multi-speaker channel history the provider must surface for GUESTs. */
const CHANNEL_HISTORY: Memory[] = [
  roomMessage(
    "aaaaaaaa-0000-0000-0000-000000000001",
    OTHER_ID,
    "shaw",
    "new channel, lets keep it high signal",
    1_000,
  ),
  roomMessage(
    "aaaaaaaa-0000-0000-0000-000000000002",
    GUEST_ID,
    "bill",
    "automated agents contributing daily",
    2_000,
  ),
  roomMessage(
    "aaaaaaaa-0000-0000-0000-000000000003",
    OTHER_ID,
    "shaw",
    "automate the grind",
    3_000,
  ),
];

function stubRuntime(): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "TestAgent" },
    getConversationLength: () => 32,
    getRoom: async (roomId: UUID) =>
      roomId === ROOM_ID
        ? { id: ROOM_ID, name: "cozy-dev", type: "GROUP", worldId: WORLD_ID }
        : null,
    getWorld: async (worldId: UUID) =>
      worldId === WORLD_ID ? { id: WORLD_ID, name: "cozy" } : null,
    getRooms: async () => [
      { id: ROOM_ID, name: "cozy-dev", type: "GROUP", worldId: WORLD_ID },
    ],
    getParticipantsForRoom: async () => [GUEST_ID, OTHER_ID, AGENT_ID],
    getEntitiesForRoom: async () => [
      { id: GUEST_ID, agentId: AGENT_ID, names: ["bill"], metadata: {} },
      { id: OTHER_ID, agentId: AGENT_ID, names: ["shaw"], metadata: {} },
      { id: AGENT_ID, agentId: AGENT_ID, names: ["TestAgent"], metadata: {} },
    ],
    getMemories: async ({ tableName }: { tableName: string }) =>
      tableName === "messages" ? [...CHANNEL_HISTORY] : [],
    getEntityById: async () => null,
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function guestMessage(text: string): Memory {
  return {
    id: "22222222-2222-2222-2222-222222222222" as UUID,
    entityId: GUEST_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 4_000,
    content: { text, source: "discord" },
    metadata: { entityName: "bill" },
  } as Memory;
}

function pluginWith(providers: Provider[]): Plugin {
  return { name: "test-plugin", providers } as Plugin;
}

describe("GUEST senders keep current-room conversation context after role gating", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
    rolesMock.checkSenderRole.mockResolvedValue({
      role: "GUEST",
      isOwner: false,
      isAdmin: false,
    });
  });

  it("RECENT_MESSAGES yields the busy room's transcript to a GUEST (addressed turn)", async () => {
    const provider = providerByName("RECENT_MESSAGES");
    applyPluginRoleGating([pluginWith([provider])]);
    // A GUEST-floor gate is non-restricting: the provider must not be wrapped.
    expect((provider as { __roleGate?: string }).__roleGate).toBeUndefined();

    const result = await provider.get(
      stubRuntime(),
      guestMessage("@TestAgent you tell me, look at the history"),
      { values: {}, data: {}, text: "" } as State,
    );

    const transcript = result?.text ?? "";
    expect(transcript).toContain("high signal");
    expect(transcript).toContain("automate the grind");
    const recentMessages = (
      result?.data as { recentMessages?: Memory[] } | undefined
    )?.recentMessages;
    expect(Array.isArray(recentMessages)).toBe(true);
    expect(recentMessages?.length).toBeGreaterThanOrEqual(3);
  });

  it("RECENT_MESSAGES yields the same transcript on an ambient (unaddressed) turn", async () => {
    const provider = providerByName("RECENT_MESSAGES");
    applyPluginRoleGating([pluginWith([provider])]);

    const result = await provider.get(
      stubRuntime(),
      guestMessage("what do you see in this chat then"),
      { values: {}, data: {}, text: "" } as State,
    );

    expect(result?.text ?? "").toContain("high signal");
  });

  it("WORLD and ENTITIES yield room awareness to a GUEST", async () => {
    const world = providerByName("WORLD");
    const entities = providerByName("ENTITIES");
    applyPluginRoleGating([pluginWith([world, entities])]);
    expect((world as { __roleGate?: string }).__roleGate).toBeUndefined();
    expect((entities as { __roleGate?: string }).__roleGate).toBeUndefined();

    const runtime = stubRuntime();
    const message = guestMessage("who is in here?");
    const worldResult = await world.get(runtime, message, {
      values: {},
      data: {},
      text: "",
    } as State);
    const entitiesResult = await entities.get(runtime, message, {
      values: {},
      data: {},
      text: "",
    } as State);

    expect(worldResult?.text ?? "").not.toBe("");
    expect(entitiesResult?.text ?? "").toContain("shaw");
  });

  it("cross-platform recall (recent-conversations, ADMIN) stays withheld from a GUEST", async () => {
    applyPluginRoleGating([pluginWith([recentConversationsProvider])]);
    expect(
      (recentConversationsProvider as { __roleGate?: string }).__roleGate,
    ).toBe("ADMIN");

    const result = await recentConversationsProvider.get(
      stubRuntime(),
      guestMessage("what have we talked about elsewhere?"),
      { values: {}, data: {}, text: "" } as State,
    );

    expect(result).toEqual({ text: "" });
  });
});
