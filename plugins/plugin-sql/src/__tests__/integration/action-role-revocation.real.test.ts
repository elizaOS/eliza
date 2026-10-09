/** Stored authority must be refreshed after asynchronous action validation. */
import { randomUUID } from "node:crypto";
import {
  ChannelType,
  checkSenderRole,
  executePlannedToolCall,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("SQL-backed action role freshness", () => {
  it.each([false, true])("revocation during validation: %s", async (revoke) => {
    const { adapter, runtime, cleanup, testAgentId } = await createIsolatedTestDatabase(
      `action-role-${randomUUID()}`
    );
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const actorId = randomUUID() as UUID;
    const effectKey = `role-effect:${randomUUID()}`;
    const enteredValidation = Promise.withResolvers<void>();
    const resumeValidation = Promise.withResolvers<void>();
    let execution: ReturnType<typeof executePlannedToolCall> | undefined;
    try {
      await adapter.createWorld({
        id: worldId,
        agentId: testAgentId,
        name: "Role freshness world",
        serverId: randomUUID(),
        metadata: {
          roles: { [actorId]: "ADMIN" },
          roleSources: { [actorId]: "manual" },
        },
      });
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          worldId,
          source: "test",
          type: ChannelType.GROUP,
        },
      ]);
      await adapter.createEntities([
        {
          id: actorId,
          agentId: testAgentId,
          names: ["Operator"],
        },
      ]);
      await adapter.addParticipant(actorId, roomId);
      const message: Memory = {
        id: randomUUID() as UUID,
        agentId: testAgentId,
        entityId: actorId,
        roomId,
        content: { text: "Perform the protected operation" },
      };
      runtime.registerAction({
        name: "ROLE_FRESHNESS_EFFECT",
        description: "Persist a marker only for a current administrator",
        roleGate: { minRole: "ADMIN" },
        contexts: ["general"],
        validate: async () => {
          enteredValidation.resolve();
          await resumeValidation.promise;
          return true;
        },
        handler: async () => {
          await adapter.setCache(effectKey, "committed");
          return { success: true };
        },
      });
      expect((await checkSenderRole(runtime, message))?.role).toBe("ADMIN");
      execution = executePlannedToolCall(
        runtime,
        { message, activeContexts: ["general"] },
        { name: "ROLE_FRESHNESS_EFFECT", params: {} }
      );
      try {
        await Promise.race([
          enteredValidation.promise,
          execution.then((result) => {
            throw new Error(`Execution ended before validation: ${JSON.stringify(result)}`);
          }),
        ]);
        if (revoke) {
          const world = await adapter.getWorld(worldId);
          if (!world) throw new Error("Stored world missing");
          await adapter.updateWorld({
            ...world,
            metadata: { ...world.metadata, roles: { [actorId]: "GUEST" } },
          });
        }
        expect((await checkSenderRole(runtime, message))?.role).toBe(revoke ? "GUEST" : "ADMIN");
      } finally {
        resumeValidation.resolve();
      }
      const result = await execution;
      expect(result.success).toBe(!revoke);
      if (revoke) expect(result.error).toContain("current role");
      expect(await adapter.getCache(effectKey)).toBe(revoke ? undefined : "committed");
    } finally {
      resumeValidation.resolve();
      if (execution) await Promise.allSettled([execution]);
      await cleanup();
    }
  });
});
