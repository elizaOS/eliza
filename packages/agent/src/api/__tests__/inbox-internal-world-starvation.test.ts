/**
 * Inbox feed starvation by internal scratch worlds.
 *
 * The bug this pins: `collectAgentRoomIds` (backing GET /api/inbox/messages
 * and GET /api/inbox/sources) enumerated rooms from EVERY world, including
 * internal scratch worlds (Autonomy World, Advanced Memory, Relationships
 * World), while the chats sidebar's `collectAgentWorlds` already skipped
 * them. `getMemoriesByRoomIds` returns newest-first across all scanned rooms
 * under a bounded limit, so an active autonomy loop — which emits synthetic
 * messages continuously into its own room — monopolized the fetch window.
 * Every fetched row was then discarded by the connector source filter and
 * the inbox rendered empty ("messages":[], "sources":[]) even though real
 * Discord messages existed just past the window.
 *
 * The harness models the real adapter contract (global newest-first order +
 * limit applied across the requested roomIds) so the starvation reproduces
 * mechanically: >3x-overfetch autonomy messages are newer than the connector
 * messages. Without the internal-world exclusion both routes return empty;
 * with it, the Discord messages surface.
 */
import type http from "node:http";
import type { AgentRuntime, RouteHelpers, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleInboxRoute, type InboxRouteState } from "../inbox-routes";

// The messages route lazily imports the full connector plugin for avatar
// caching; the test exercises room enumeration, not avatar fetching.
vi.mock("@elizaos/plugin-discord", () => ({
  cacheDiscordAvatarUrl: async (avatarUrl: string | undefined) => avatarUrl,
}));

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const GUILD_WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const AUTONOMY_WORLD_ID = "00000000-0000-0000-0000-0000000000e2" as UUID;
const DISCORD_ROOM_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const AUTONOMY_ROOM_ID = "00000000-0000-0000-0000-0000000000b2" as UUID;

interface StoredMemory {
  id: UUID;
  roomId: UUID;
  entityId?: UUID;
  content: { text: string; source?: string };
  createdAt: number;
}

function makeHarness(options: { autonomyMessageCount: number }) {
  const worlds = [
    { id: GUILD_WORLD_ID, agentId: AGENT_ID, name: "Guild" },
    // Name-marker match for isInternalWorld — same shape the autonomy
    // service creates in production.
    { id: AUTONOMY_WORLD_ID, agentId: AGENT_ID, name: "Autonomy World" },
  ];
  const roomsByWorld = new Map<string, Array<Record<string, unknown>>>([
    [
      GUILD_WORLD_ID,
      [
        {
          id: DISCORD_ROOM_ID,
          name: "#general",
          source: "discord",
          type: "GROUP",
          worldId: GUILD_WORLD_ID,
          channelId: "discord-channel-1",
        },
      ],
    ],
    [
      AUTONOMY_WORLD_ID,
      [
        {
          id: AUTONOMY_ROOM_ID,
          name: "Autonomous Thoughts",
          source: "autonomy-service",
          type: "SELF",
          worldId: AUTONOMY_WORLD_ID,
        },
      ],
    ],
  ]);

  // One shared, globally newest-first store — the adapter contract the
  // production SQL implements (ORDER BY created_at DESC ... LIMIT n across
  // the requested roomIds).
  const memories: StoredMemory[] = [];
  // Older, real connector traffic.
  for (let i = 0; i < 5; i++) {
    memories.push({
      id: `00000000-0000-0000-0000-0000000000d${i}` as UUID,
      roomId: DISCORD_ROOM_ID,
      entityId: `00000000-0000-0000-0000-0000000000f${i}` as UUID,
      content: { text: `real dm ${i}`, source: "discord" },
      createdAt: 1_000 + i,
    });
  }
  // Newer autonomy chatter that crowds the fetch window.
  for (let i = 0; i < options.autonomyMessageCount; i++) {
    memories.push({
      id: `00000000-0000-0000-${String(1000 + i).padStart(4, "0")}-000000000000` as UUID,
      roomId: AUTONOMY_ROOM_ID,
      entityId: AGENT_ID,
      content: { text: `autonomous thought ${i}` },
      createdAt: 10_000 + i,
    });
  }

  const runtime = {
    agentId: AGENT_ID,
    getAllWorlds: async () => worlds,
    getRoomsByWorlds: async (worldIds: UUID[]) =>
      worldIds.flatMap((worldId) => roomsByWorld.get(worldId) ?? []),
    getMemories: async () => [],
    getMemoriesByRoomIds: async ({
      roomIds,
      limit,
    }: {
      roomIds: UUID[];
      limit?: number;
    }) => {
      const requested = new Set<string>(roomIds);
      const matched = memories
        .filter((memory) => requested.has(memory.roomId))
        .sort((a, b) => b.createdAt - a.createdAt);
      return limit !== undefined ? matched.slice(0, limit) : matched;
    },
    getRoom: async (roomId: UUID) => {
      for (const rooms of roomsByWorld.values()) {
        const found = rooms.find((room) => room.id === roomId);
        if (found) return found;
      }
      return null;
    },
    getService: () => null,
  } as unknown as AgentRuntime;

  return { runtime };
}

async function getRoute(runtime: AgentRuntime, pathname: string) {
  let payload: Record<string, unknown> | undefined;
  const helpers = {
    json: (_res: http.ServerResponse, data: unknown) => {
      payload = data as Record<string, unknown>;
    },
    error: (_res: http.ServerResponse, message: string) => {
      throw new Error(`route error: ${message}`);
    },
    readJsonBody: async () => null,
  } as unknown as RouteHelpers;

  const handled = await handleInboxRoute(
    { url: pathname } as http.IncomingMessage,
    {} as http.ServerResponse,
    pathname,
    "GET",
    { runtime } as InboxRouteState,
    helpers,
  );
  expect(handled).toBe(true);
  if (!payload) throw new Error("route did not respond");
  return payload;
}

describe("GET /api/inbox — internal worlds must not starve the connector feed", () => {
  it("returns connector messages even when a busy autonomy room has newer traffic than the whole fetch window", async () => {
    // 350 > default limit (100) * PER_ROOM_OVERFETCH_MULTIPLIER (3): with
    // the autonomy room included in the scan, the entire window is
    // autonomy chatter and the discord messages never surface.
    const { runtime } = makeHarness({ autonomyMessageCount: 350 });

    const payload = await getRoute(runtime, "/api/inbox/messages");
    const messages = payload.messages as Array<Record<string, unknown>>;

    expect(payload.count).toBe(5);
    expect(messages).toHaveLength(5);
    for (const message of messages) {
      expect(message.source).toBe("discord");
    }
  });

  it("reports discord in /api/inbox/sources despite >1000 newer autonomy messages", async () => {
    // loadInboxSources samples a bounded 1000-message page; enough newer
    // autonomy chatter previously pushed every connector row out of it.
    const { runtime } = makeHarness({ autonomyMessageCount: 1_200 });

    const payload = await getRoute(runtime, "/api/inbox/sources");
    expect(payload.sources).toEqual(["discord"]);
  });
});
