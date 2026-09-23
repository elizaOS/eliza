/** Exercises live owner/device room authority and revocation using real SQLite. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  stringToUuid,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, it } from "vitest";
import { createConversationSessionScope } from "./conversation-session-scope";
import type { PersistentSessionActor } from "./persistent-session-admission";

it.each(["owner", "machine"] as const)(
  "pairing %s grants no rooms and membership revocation survives reopen",
  async (identityKind) => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-session-scope-"));
    const agentId = stringToUuid(`scope-agent-${identityKind}`);
    const actor: PersistentSessionActor = {
      identityId: `scope-${identityKind}`,
      identityKind,
      source: "bearer-session",
      scopes: [],
    };
    const roomId = stringToUuid("shared-room");
    const otherRoom = stringToUuid("other-room");
    const openRuntime = async () => {
      const adapter = SQLiteDatabaseAdapter.create(
        join(directory, "agent.sqlite"),
        agentId,
      );
      await adapter.initialize();
      const runtime = new AgentRuntime({
        agentId,
        adapter,
        character: createCharacter({ name: "Scope" }),
        logLevel: "fatal",
        plugins: [],
        enableAutonomy: false,
      });
      return {
        runtime,
        adapter,
        resolve: createConversationSessionScope({ runtime, config: {} }),
      };
    };
    let opened = await openRuntime();
    try {
      const initial = await opened.resolve(actor);
      expect(initial.authorizedRoomIds).toEqual([]);
      await opened.adapter.createAgents([{ id: agentId, name: "Scope" }]);
      await opened.adapter.createEntities([
        { id: initial.requesterEntityId, agentId, names: ["Paired"] },
        { id: agentId, agentId, names: ["Agent"] },
      ]);
      await opened.adapter.createRooms(
        [roomId, otherRoom].map((id) => ({
          id,
          agentId,
          type: ChannelType.API,
          source: "test",
        })),
      );
      await opened.adapter.createRoomParticipants(
        [initial.requesterEntityId],
        roomId,
      );
      expect((await opened.resolve(actor)).authorizedRoomIds).toEqual([]);
      await opened.adapter.createRoomParticipants([agentId], roomId);
      await opened.adapter.createRoomParticipants([agentId], otherRoom);
      expect((await opened.resolve(actor)).authorizedRoomIds).toEqual([roomId]);
      await opened.adapter.deleteParticipants([
        { entityId: initial.requesterEntityId, roomId },
      ]);
      expect((await opened.resolve(actor)).authorizedRoomIds).toEqual([]);
      await opened.runtime.close();
      opened = await openRuntime();
      const restored = await opened.resolve(actor);
      expect(restored.requesterEntityId).toBe(initial.requesterEntityId);
      expect(restored.authorizedRoomIds).toEqual([]);
      expect(restored.role).toBe(identityKind === "owner" ? "OWNER" : "USER");
    } finally {
      await opened.runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
