/**
 * Exercises ROLE batch assignments against the real core in-memory adapter:
 * a batch that mixes a valid entity UUID with a name is refused by the declared
 * schema and, when the handler is reached anyway, writes nothing. Deterministic
 * harness — real adapter and CAS path, stub runtime around it, no model.
 */

import type { IAgentRuntime, Memory, UUID, World } from "@elizaos/core";
import { ChannelType, stringToUuid, validateToolArgs } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import { roleAction } from "./role.ts";

const AGENT_ID = stringToUuid("role-batch-test-agent") as UUID;
const ROOM_ID = stringToUuid("role-batch-test-room") as UUID;
const WORLD_ID = stringToUuid("role-batch-test-world") as UUID;
const OWNER_ID = stringToUuid("role-batch-test-owner") as UUID;
const TARGET_ID = stringToUuid("role-batch-test-target") as UUID;

async function buildRuntime(): Promise<{
  runtime: IAgentRuntime;
  roles: () => Promise<Record<string, string>>;
}> {
  const adapter = SQLiteDatabaseAdapter.create(":memory:", AGENT_ID);
  await adapter.init();
  await adapter.createWorlds([
    {
      id: WORLD_ID,
      agentId: AGENT_ID,
      name: "role-batch-world",
      metadata: {
        ownership: { ownerId: OWNER_ID },
        roles: { [OWNER_ID]: "OWNER", [TARGET_ID]: "USER" },
      } as unknown as World["metadata"],
    },
  ]);
  await adapter.createRooms([
    {
      id: ROOM_ID,
      agentId: AGENT_ID,
      worldId: WORLD_ID,
      source: "test",
      type: ChannelType.GROUP,
    },
  ]);
  const runtime = {
    agentId: AGENT_ID,
    adapter,
    getSetting: () => null,
    getRoom: async (roomId: UUID) =>
      (await adapter.getRoomsByIds([roomId]))?.[0] ?? null,
    getWorld: async (worldId: UUID) =>
      (await adapter.getWorldsByIds([worldId]))[0] ?? null,
    getEntityById: async () => null,
    getEntitiesForRoom: async () => [],
  } as unknown as IAgentRuntime;
  return {
    runtime,
    roles: async () => {
      const rows = await adapter.getWorldsByIds([WORLD_ID]);
      return (
        (rows[0]?.metadata as { roles?: Record<string, string> })?.roles ?? {}
      );
    },
  };
}

function buildMessage(): Memory {
  return {
    id: stringToUuid("role-batch-message"),
    entityId: OWNER_ID,
    roomId: ROOM_ID,
    agentId: AGENT_ID,
    content: {
      text: "make them admins",
      channelType: ChannelType.GROUP,
    },
  } as Memory;
}

const MIXED_BATCH = {
  action: "assign",
  assignments: [
    { entityId: TARGET_ID, newRole: "ADMIN" },
    { entityId: "Sam", newRole: "USER" },
  ],
};

describe("ROLE batch assignments", () => {
  it("declares assignments[].entityId as an entity UUID", () => {
    expect(validateToolArgs(roleAction, MIXED_BATCH).errors).toEqual([
      expect.stringContaining("assignments[1].entityId"),
    ]);
    expect(
      validateToolArgs(roleAction, {
        action: "assign",
        assignments: [{ entityId: TARGET_ID, newRole: "ADMIN" }],
      }).errors,
    ).toEqual([]);
  });

  it("writes nothing when one entry of the batch is not an entity UUID", async () => {
    const { runtime, roles } = await buildRuntime();

    const result = await roleAction.handler(
      runtime,
      buildMessage(),
      undefined,
      { parameters: MIXED_BATCH },
    );

    expect(result).toMatchObject({
      success: false,
      error: "ROLE_ASSIGN_FAILED",
    });
    expect(result?.text).toContain('Invalid entityId "Sam"');
    expect((await roles())[TARGET_ID]).toBe("USER");
  });

  it("does not fall back to a named target after rejecting every batch entry", async () => {
    const { runtime, roles } = await buildRuntime();
    runtime.getEntitiesForRoom = async () => [
      { id: TARGET_ID, names: ["Alex"], metadata: {} },
    ];
    const result = await roleAction.handler(
      runtime,
      buildMessage(),
      undefined,
      {
        parameters: {
          action: "assign",
          assignments: [{ entityId: "Sam", newRole: "ADMIN" }],
          target: "Alex",
          role: "ADMIN",
        },
      },
    );
    expect(result).toMatchObject({
      success: false,
      error: "ROLE_ASSIGN_FAILED",
    });
    expect((await roles())[TARGET_ID]).toBe("USER");
  });

  it.each([null, {}, 42, { entityId: 42 }])(
    "rejects a malformed batch entry %j before writing a valid entry",
    async (entry) => {
      const { runtime, roles } = await buildRuntime();
      const result = await roleAction.handler(
        runtime,
        buildMessage(),
        undefined,
        {
          parameters: {
            action: "assign",
            assignments: [{ entityId: TARGET_ID, newRole: "ADMIN" }, entry],
          },
        },
      );
      expect(result).toMatchObject({
        success: false,
        error: "ROLE_ASSIGN_FAILED",
      });
      expect((await roles())[TARGET_ID]).toBe("USER");
    },
  );

  it("still applies a batch whose entries are all entity UUIDs", async () => {
    const { runtime, roles } = await buildRuntime();

    const result = await roleAction.handler(
      runtime,
      buildMessage(),
      undefined,
      {
        parameters: {
          action: "assign",
          assignments: [{ entityId: TARGET_ID, newRole: "ADMIN" }],
        },
      },
    );

    expect(result).toMatchObject({ success: true });
    expect((await roles())[TARGET_ID]).toBe("ADMIN");
  });
});
