/** Exercises role hierarchy output and read admission across batching, missing identities and invalid contexts. */
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { roleProvider } from "./roles.ts";

const message = { roomId: "room" } as Memory;
const state = (
  type = ChannelType.GROUP,
  worldId: string | undefined = "world",
) => ({ data: { room: { type, worldId } } }) as State;

function fixture(roles: Record<string, string> = {}) {
  const getEntitiesByIds = vi.fn().mockResolvedValue([]);
  const getEntityById = vi.fn();
  const getWorld = vi.fn().mockResolvedValue({
    metadata: { ownership: { ownerId: "owner" }, roles },
  });
  return {
    runtime: {
      agentId: "agent",
      getWorld,
      getEntitiesByIds,
      getEntityById,
    } as unknown as IAgentRuntime,
    getWorld,
    getEntitiesByIds,
    getEntityById,
  };
}

describe("roleProvider entity batching", () => {
  it("preserves role order, identity fallbacks, missing rows and duplicate usernames", async () => {
    const f = fixture({
      owner: "OWNER",
      missing: "ADMIN",
      admin: "ADMIN",
      duplicate: "ADMIN",
      unnamed: "MEMBER",
      member: "MEMBER",
    });
    const entities = [
      { id: "member", names: ["Member"] },
      {
        id: "duplicate",
        names: ["Duplicate"],
        metadata: { username: "admin-handle" },
      },
      {
        id: "unnamed",
        names: [],
        metadata: { name: "Unnamed", username: "unnamed" },
      },
      {
        id: "admin",
        names: ["Admin alias"],
        metadata: { discord: { name: "Admin", userName: "admin-handle" } },
      },
      {
        id: "owner",
        names: ["Owner alias"],
        metadata: { name: "Owner", username: "owner-handle" },
      },
    ];
    f.getEntitiesByIds.mockResolvedValue(entities);
    f.getEntityById.mockImplementation(
      async (id: string) => entities.find((entity) => entity.id === id) ?? null,
    );
    const text =
      "# Server Role Hierarchy\n\n## Owners\nOwner (Owner alias)\n\n## Administrators\nAdmin (Admin alias) (admin-handle)\n\n## Members\nMember (Member) (Member)\n";
    expect(await roleProvider.get(f.runtime, message, state())).toEqual({
      text,
      data: { roles: text },
      values: { roles: text },
    });
    expect(f.getEntitiesByIds).toHaveBeenCalledExactlyOnceWith([
      "owner",
      "missing",
      "admin",
      "duplicate",
      "unnamed",
      "member",
    ]);
    expect(f.getEntityById).not.toHaveBeenCalled();
  });

  it("does not read worlds or entities for direct messages", async () => {
    const f = fixture({ owner: "OWNER" });
    const result = await roleProvider.get(
      f.runtime,
      message,
      state(ChannelType.DM),
    );
    expect(result.text).toContain("No access to role information in DMs");
    expect(f.getWorld).not.toHaveBeenCalled();
    expect(f.getEntitiesByIds).not.toHaveBeenCalled();
  });

  it("rejects a group without a world before reading role data", async () => {
    const f = fixture({ owner: "OWNER" });
    const noWorld = { data: { room: { type: ChannelType.GROUP } } } as State;
    await expect(roleProvider.get(f.runtime, message, noWorld)).rejects.toThrow(
      "No world ID found for room",
    );
    expect(f.getWorld).not.toHaveBeenCalled();
    expect(f.getEntitiesByIds).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { metadata: { roles: { owner: "OWNER" } } },
    { metadata: { ownership: { ownerId: "owner" }, roles: {} } },
  ])(
    "does not query entities without owned-world role data: %j",
    async (world) => {
      const f = fixture();
      f.getWorld.mockResolvedValue(world);
      expect((await roleProvider.get(f.runtime, message, state())).text).toBe(
        "No role information available for this server.",
      );
      expect(f.getEntitiesByIds).not.toHaveBeenCalled();
    },
  );

  it("propagates entity read failure instead of presenting an empty hierarchy", async () => {
    const f = fixture({ owner: "OWNER" });
    f.getEntitiesByIds.mockRejectedValue(new Error("Entity query failed"));
    f.getEntityById.mockRejectedValue(new Error("Entity query failed"));
    await expect(roleProvider.get(f.runtime, message, state())).rejects.toThrow(
      "Entity query failed",
    );
  });
});
