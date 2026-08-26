/**
 * Verifies runtime role bootstrap uses core's real in-memory CAS authority,
 * retaining an audited OWNER transition without invoking the blind writer.
 */
import {
  AgentRuntime,
  ChannelType,
  type Character,
  InMemoryDatabaseAdapter,
  ROLE_WRITE_AUDIT_LOG_TYPE,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import rolesPlugin from "./index";

describe("runtime roles bootstrap CAS", () => {
  it("commits the configured owner and audit through adapter CAS", async () => {
    const runtime = new AgentRuntime({
      character: { name: "roles-cas" } as Character,
    });
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();
    runtime.registerDatabaseAdapter(adapter);
    const ownerId = stringToUuid("runtime-roles-owner") as UUID;
    const worldId = stringToUuid("runtime-roles-world") as UUID;
    const roomId = stringToUuid("runtime-roles-room") as UUID;
    await adapter.createEntities([
      { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
    ]);
    await adapter.createWorlds([
      { id: worldId, agentId: runtime.agentId, name: "Roles", metadata: {} },
    ]);
    await adapter.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        worldId,
        source: "test",
        type: ChannelType.WORLD,
      },
    ]);
    (
      runtime as unknown as { getSetting: (key: string) => unknown }
    ).getSetting = (key) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? ownerId : undefined;
    (runtime as unknown as { updateWorld: () => Promise<void> }).updateWorld =
      async () => {
        throw new Error("blind world writer must not run");
      };

    await rolesPlugin.init?.({}, runtime);

    const world = (await adapter.getWorldsByIds([worldId]))[0];
    if (!world) throw new Error("runtime roles CAS test world missing");
    expect(
      (world.metadata as { roles?: Record<string, string> }).roles?.[ownerId],
    ).toBe("OWNER");
    const audits = await adapter.getLogs({ type: ROLE_WRITE_AUDIT_LOG_TYPE });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.body).toMatchObject({
      metadata: {
        targetEntityId: ownerId,
        previousRole: "GUEST",
        newRole: "OWNER",
      },
    });
  });
});
