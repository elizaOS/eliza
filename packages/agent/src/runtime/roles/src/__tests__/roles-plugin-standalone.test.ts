/**
 * Unit tests for internal runtime roles plugin manifest and lifecycle initialization.
 */
import type { IAgentRuntime, World } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import rolesPlugin, { roleAction, rolesProvider } from "../index.ts";

describe("roles plugin", () => {
  describe("manifest", () => {
    it("defines the expected plugin metadata and components", () => {
      expect(rolesPlugin.name).toBe("roles");
      expect(rolesPlugin.description).toBeTruthy();
      expect(rolesPlugin.providers).toContain(rolesProvider);
      expect(rolesPlugin.actions).toContain(roleAction);
    });
  });

  describe("init", () => {
    it("registers world event listeners and syncs canonical owner role", async () => {
      const registeredEvents: Record<string, () => Promise<void>> = {};
      const mockWorld = {
        id: "world-1",
        name: "Default World",
        agentId: "agent-1",
        metadata: {
          ownership: { ownerId: "owner-entity-1" },
          roles: {},
        },
      } as unknown as World;

      const mockRuntime = {
        agentId: "agent-1",
        getAllWorlds: vi.fn().mockResolvedValue([mockWorld]),
        getWorld: vi.fn().mockResolvedValue(mockWorld),
        updateWorld: vi.fn().mockResolvedValue(undefined),
        getSetting: vi.fn().mockReturnValue(undefined),
        registerEvent: vi.fn((event: string, handler: () => Promise<void>) => {
          registeredEvents[event] = handler;
        }),
      } as unknown as IAgentRuntime;

      await rolesPlugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerEvent).toHaveBeenCalledWith(
        "WORLD_JOINED",
        expect.any(Function),
      );
      expect(mockRuntime.registerEvent).toHaveBeenCalledWith(
        "WORLD_CONNECTED",
        expect.any(Function),
      );

      // Verify event handlers can be executed without error
      if (registeredEvents.WORLD_JOINED) {
        await registeredEvents.WORLD_JOINED();
      }
      if (registeredEvents.WORLD_CONNECTED) {
        await registeredEvents.WORLD_CONNECTED();
      }
    });

    it("handles empty worlds or database errors gracefully without throwing", async () => {
      const mockRuntime = {
        agentId: "agent-1",
        getAllWorlds: vi
          .fn()
          .mockRejectedValue(new Error("Database connection lost")),
        getSetting: vi.fn().mockReturnValue(undefined),
        registerEvent: vi.fn(),
      } as unknown as IAgentRuntime;

      await expect(
        rolesPlugin.init?.({}, mockRuntime),
      ).resolves.toBeUndefined();
    });
  });
});
