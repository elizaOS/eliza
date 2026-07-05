/**
 * Real relaunch/server-truth persistence e2e for web-chat conversations (#13689).
 *
 * "My conversation is still there after I reopen the app" had no automated
 * assertion that isn't mock-substituted: the web spec asserts reload against an
 * in-spec mock store, so it proves client rehydration, not the real agent-DB
 * round trip. This drives the REAL restore path (`restoreConversationsFromDb`,
 * extracted from the server boot closure so it is testable) against a REAL,
 * migrated PGlite database:
 *
 *   persist a web-chat room (channelId `web-conv-<id>`) + a marker message
 *   → simulate a relaunch by rebuilding a fresh, empty conversation registry
 *   → run the real restore → the conversation reappears from DB truth and the
 *     marker message is still readable via `getMemories`.
 *
 * Plus the guards a real regression would trip: a fresh registry with no
 * persisted rooms restores nothing (no fabrication), non-web-chat rooms are
 * ignored, an already-loaded conversation is not duplicated, and a
 * deleted-this-session id is never resurrected.
 */

import { restoreConversationsFromDb } from "@elizaos/agent";
import {
  type AgentRuntime,
  ChannelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { createTestDatabase } from "@elizaos/plugin-sql/__tests__/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const AGENT_ID = "00000000-0000-0000-0000-000000136890" as UUID;

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let worldId: UUID;

/** Persist a web-chat conversation (world+room) with one marker message. */
async function seedConversation(
  convId: string,
  markerText: string,
  channelIdOverride?: string,
): Promise<UUID> {
  const roomId = stringToUuid(`room-${convId}`);
  await runtime.createRoom({
    id: roomId,
    name: `Chat ${convId}`,
    source: "web",
    type: ChannelType.DM,
    channelId: channelIdOverride ?? `web-conv-${convId}`,
    worldId,
  });
  await runtime.createMemory(
    {
      entityId: runtime.agentId,
      roomId,
      content: { text: markerText },
    } as never,
    "messages",
  );
  return roomId;
}

beforeAll(async () => {
  const db = await createTestDatabase(AGENT_ID, [sqlPlugin]);
  runtime = db.runtime;
  cleanup = db.cleanup;
  worldId = stringToUuid(`${runtime.character.name ?? "Eliza"}-web-chat-world`);
  await runtime.createWorld({
    id: worldId,
    name: "web-chat",
    agentId: runtime.agentId,
    serverId: "test-server",
  } as never);
  // Marker messages are authored by the agent entity; satisfy the memories FK.
  await runtime.createEntity({
    id: runtime.agentId,
    agentId: runtime.agentId,
    names: ["Agent"],
  } as never);
});

afterAll(async () => {
  await cleanup?.();
});

describe("web-chat conversation relaunch persistence — real DB (#13689)", () => {
  it("restores a persisted conversation from DB truth after a relaunch and the marker message survives", async () => {
    const convId = "aaaaaaaa-1111-2222-3333-444444444444";
    const marker = `MARKER-relaunch-${convId}`;
    const roomId = await seedConversation(convId, marker);

    // Relaunch: a fresh process has an empty in-memory conversation registry.
    const conversations = new Map();
    const deletedConversationIds = new Set<string>();
    const restored = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds,
    });

    // The conversation is rebuilt from server truth, mapped to its real room.
    expect(restored).toBe(1);
    expect(conversations.has(convId)).toBe(true);
    expect(conversations.get(convId)).toMatchObject({
      id: convId,
      roomId,
      title: `Chat ${convId}`,
    });

    // And the sent message is still there — read from the real DB, not
    // optimistic client state.
    const msgs = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 10,
    });
    expect(
      msgs.some((m) => (m.content as { text?: string })?.text === marker),
    ).toBe(true);
  });

  it("restores nothing into a fresh registry when no web-chat rooms are persisted (no fabrication)", async () => {
    // A pristine runtime/world with no rooms at all.
    const empty = await createTestDatabase(
      "00000000-0000-0000-0000-000000136891" as UUID,
      [sqlPlugin],
    );
    try {
      const conversations = new Map();
      const restored = await restoreConversationsFromDb(empty.runtime, {
        conversations,
        deletedConversationIds: new Set(),
      });
      expect(restored).toBe(0);
      expect(conversations.size).toBe(0);
    } finally {
      await empty.cleanup();
    }
  });

  it("ignores non-web-chat rooms and does not duplicate an already-loaded conversation", async () => {
    const convId = "bbbbbbbb-1111-2222-3333-555555555555";
    await seedConversation(convId, "second-marker");
    // A room in the same world that is NOT a web-chat conversation.
    await seedConversation(
      "cccccccc-9999-9999-9999-999999999999",
      "discord-noise",
      "discord-channel-xyz",
    );

    const conversations = new Map();
    const first = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds: new Set(),
    });
    // Only the two web-conv rooms (this test's + the first test's) restore; the
    // discord-channel room is skipped.
    expect(first).toBeGreaterThanOrEqual(1);
    expect([...conversations.keys()]).toContain(convId);
    expect([...conversations.keys()]).not.toContain(
      "cccccccc-9999-9999-9999-999999999999",
    );

    // Re-running against the now-populated registry restores no duplicates.
    const second = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds: new Set(),
    });
    expect(second).toBe(0);
  });

  it("never resurrects a conversation the operator deleted this session", async () => {
    const convId = "dddddddd-1111-2222-3333-666666666666";
    await seedConversation(convId, "deleted-marker");

    const conversations = new Map();
    const restored = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds: new Set([convId]),
    });
    expect(conversations.has(convId)).toBe(false);
    // (other web-conv rooms may still restore; the deleted one must not)
    expect([...conversations.keys()]).not.toContain(convId);
    expect(restored).toBeGreaterThanOrEqual(0);
  });
});
