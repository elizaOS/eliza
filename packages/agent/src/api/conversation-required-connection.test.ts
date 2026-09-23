/**
 * Exercises existing-conversation preparation with real AgentRuntime and SQLite.
 * A previously admitted scope cannot recreate removed memberships or rewrite
 * persisted role grants. Legacy creation establishes the fixture's real topology.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccessContext,
  AgentRuntime,
  createCharacter,
  stringToUuid,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, it } from "vitest";
import {
  type ConversationCaller,
  type ConversationRouteState,
  ensureConversationRoom,
} from "./conversation-routes";
import type { ConversationMeta } from "./server-types";

it("validates scoped topology without restoring revoked participants or role grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-scoped-connection-"));
  const agentId = stringToUuid("scoped-connection-agent");
  const actor = stringToUuid("scoped-connection-actor");
  const owner = stringToUuid("scoped-connection-owner");
  const roomId = stringToUuid("scoped-connection-room");
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  await adapter.initialize();
  const runtime = new AgentRuntime({
    agentId,
    adapter,
    character: createCharacter({ name: "Scoped connection" }),
    plugins: [],
    logLevel: "fatal",
    enableAutonomy: false,
  });
  const state: ConversationRouteState = {
    runtime,
    config: {},
    agentName: "Scoped connection",
    adminEntityId: owner,
    chatUserId: owner,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  };
  const conversation: ConversationMeta = {
    id: roomId,
    roomId,
    title: "Existing",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const caller: ConversationCaller = {
    entityId: actor,
    role: "USER",
    userName: "Paired device",
    grantSource: "session",
  };
  const scope = {
    requesterEntityId: actor,
    role: "USER",
    authorizedRoomIds: [roomId],
  } satisfies AccessContext;
  try {
    await adapter.createAgents([{ id: agentId, name: "Scoped connection" }]);
    const descriptor = await ensureConversationRoom(
      state,
      runtime,
      conversation,
      caller,
    );
    await ensureConversationRoom(state, runtime, conversation, caller, scope);
    await adapter.deleteParticipants([{ entityId: actor, roomId }]);
    await expect(
      ensureConversationRoom(state, runtime, conversation, caller, scope),
    ).rejects.toMatchObject({ code: "CONVERSATION_CONNECTION_SCOPE_REJECTED" });
    expect(await adapter.getRoomsForParticipants([actor])).not.toContain(
      roomId,
    );

    await adapter.createRoomParticipants([actor], roomId);
    await adapter.deleteParticipants([{ entityId: agentId, roomId }]);
    await expect(
      ensureConversationRoom(state, runtime, conversation, caller, scope),
    ).rejects.toMatchObject({ code: "CONVERSATION_CONNECTION_SCOPE_REJECTED" });
    expect(await adapter.getRoomsForParticipants([agentId])).not.toContain(
      roomId,
    );

    await adapter.createRoomParticipants([agentId], roomId);
    const [world] = await adapter.getWorldsByIds([descriptor.worldId]);
    if (!world) throw new Error("Fixture world missing");
    await adapter.updateWorlds([
      {
        ...world,
        metadata: {
          ...world.metadata,
          roles: { [actor]: "GUEST" },
          roleSources: { [actor]: "manual" },
        },
      },
    ]);
    const before = await adapter.getWorldsByIds([descriptor.worldId]);
    await ensureConversationRoom(state, runtime, conversation, caller, scope);
    expect(await adapter.getWorldsByIds([descriptor.worldId])).toEqual(before);
    await expect(
      ensureConversationRoom(state, runtime, conversation, caller, {
        ...scope,
        authorizedRoomIds: [],
      }),
    ).rejects.toMatchObject({ code: "CONVERSATION_CONNECTION_SCOPE_REJECTED" });
    await expect(
      ensureConversationRoom(state, runtime, conversation, caller, {
        ...scope,
        requesterEntityId: owner,
      }),
    ).rejects.toMatchObject({ code: "CONVERSATION_CONNECTION_SCOPE_REJECTED" });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
