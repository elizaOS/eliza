import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entities from "../entities";
import * as logger_module from "../logger";
import { findWorldsForOwner, getUserServerRole } from "../roles";
import { type IAgentRuntime, Role, type UUID, type World } from "../types";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

describe("roles utilities", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Create REAL runtime
    runtime = await createTestRuntime();

    // Set up scoped mocks for this test
    vi.spyOn(entities, "createUniqueUuid").mockImplementation(
      (_runtime: IAgentRuntime, serverId: string) =>
        `unique-${serverId}` as UUID,
    );

    // Mock logger if it doesn't have the methods
    if (logger_module.logger) {
      const methods = ["error", "info", "warn", "debug"];
      methods.forEach((method) => {
        if (
          typeof logger_module.logger[
            method as keyof typeof logger_module.logger
          ] === "function"
        ) {
          vi.spyOn(
            logger_module.logger,
            method as keyof typeof logger_module.logger,
          ).mockImplementation(() => {});
        } else {
          logger_module.logger[method as keyof typeof logger_module.logger] =
            vi.fn(
              () => {},
            ) as (typeof logger_module.logger)[keyof typeof logger_module.logger];
        }
      });
    }

    // Spy on runtime.logger methods
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTestRuntime(runtime);
  });

  describe("getUserServerRole", () => {
    it("should return role from world metadata", async () => {
      const mockWorld: World = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123",
        metadata: {
          roles: {
            ["user-123-456-789-abc-def012345678" as UUID]: Role.ADMIN,
          },
        },
      };

      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);

      const role = await getUserServerRole(
        runtime,
        "user-123-456-789-abc-def012345678",
        "server-123",
      );
      expect(role).toBe(Role.ADMIN);
    });

    it("should return Role.NONE when world is null", async () => {
      vi.spyOn(runtime, "getWorld").mockResolvedValue(null);

      const role = await getUserServerRole(runtime, "user-123", "server-123");
      expect(role).toBe(Role.NONE);
    });

    it("should return Role.NONE when world has no metadata", async () => {
      const mockWorld: World = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123",
        metadata: {},
      };

      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);

      const role = await getUserServerRole(runtime, "user-123", "server-123");
      expect(role).toBe(Role.NONE);
    });

    it("should return Role.NONE when world has no roles in metadata", async () => {
      const mockWorld: World = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123",
        metadata: {
          someOtherData: "value",
        },
      };

      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);

      const role = await getUserServerRole(runtime, "user-123", "server-123");
      expect(role).toBe(Role.NONE);
    });

    it("should check original ID format when first check fails", async () => {
      const mockWorld: World = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123",
        metadata: {
          roles: {
            ["user-456-789-abc-def-012345678901" as UUID]: Role.OWNER,
          },
        },
      };

      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);

      // Even though the code has duplicate checks for entityId, it should return NONE
      // since 'user-123' is not in the roles
      const role = await getUserServerRole(runtime, "user-123", "server-123");
      expect(role).toBe(Role.NONE);
    });

    it("should return role for different role types", async () => {
      const mockWorld: World = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123",
        metadata: {
          roles: {
            ["owner-user-123-456-789-abcdef0123" as UUID]: Role.OWNER,
            ["admin-user-123-456-789-abcdef0123" as UUID]: Role.ADMIN,
            ["none-user-123-456-789-abcdef01234" as UUID]: Role.NONE,
          },
        },
      };

      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);

      const ownerRole = await getUserServerRole(
        runtime,
        "owner-user-123-456-789-abcdef0123",
        "server-123",
      );
      expect(ownerRole).toBe(Role.OWNER);

      const adminRole = await getUserServerRole(
        runtime,
        "admin-user-123-456-789-abcdef0123",
        "server-123",
      );
      expect(adminRole).toBe(Role.ADMIN);

      const noneRole = await getUserServerRole(
        runtime,
        "none-user-123-456-789-abcdef01234",
        "server-123",
      );
      expect(noneRole).toBe(Role.NONE);
    });
  });

  describe("findWorldsForOwner", () => {
    it("should find worlds where user is owner", async () => {
      const mockWorlds: World[] = [
        {
          id: "world-1" as UUID,
          name: "World 1",
          agentId: runtime.agentId,
          messageServerId: "server-1",
          metadata: {
            ownership: {
              ownerId: "user-123",
            },
          },
        },
        {
          id: "world-2" as UUID,
          name: "World 2",
          agentId: runtime.agentId,
          messageServerId: "server-2",
          metadata: {
            ownership: {
              ownerId: "other-user",
            },
          },
        },
        {
          id: "world-3" as UUID,
          name: "World 3",
          agentId: runtime.agentId,
          messageServerId: "server-3",
          metadata: {
            ownership: {
              ownerId: "user-123",
            },
          },
        },
      ];

      vi.spyOn(runtime, "getAllWorlds").mockResolvedValue(mockWorlds);

      const ownerWorlds = await findWorldsForOwner(runtime, "user-123");

      expect(ownerWorlds).toBeDefined();
      expect(ownerWorlds?.length).toBe(2);
      const ownerWorlds0 = ownerWorlds?.[0];
      const ownerWorlds1 = ownerWorlds?.[1];
      expect(ownerWorlds0?.id).toBe("world-1" as UUID);
      expect(ownerWorlds1?.id).toBe("world-3" as UUID);
    });

    it("should return null when entityId is empty", async () => {
      const { logger } = await import("../logger");

      const result = await findWorldsForOwner(runtime, "");

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        { src: "core:roles", agentId: runtime.agentId },
        "User ID is required to find server",
      );
    });

    it("should return null when entityId is null", async () => {
      const { logger } = await import("../logger");

      // Testing with null value (intentional type test)
      const result = await findWorldsForOwner(runtime, null as string);

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        { src: "core:roles", agentId: runtime.agentId },
        "User ID is required to find server",
      );
    });

    it("should return null when no worlds exist", async () => {
      const { logger } = await import("../logger");

      vi.spyOn(runtime, "getAllWorlds").mockResolvedValue([]);

      const result = await findWorldsForOwner(runtime, "user-123");

      expect(result).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        { src: "core:roles", agentId: runtime.agentId },
        "No worlds found for agent",
      );
    });

    it("should return null when getAllWorlds returns null", async () => {
      const { logger } = await import("../logger");

      vi.spyOn(runtime, "getAllWorlds").mockResolvedValue([]);

      const result = await findWorldsForOwner(runtime, "user-123");

      expect(result).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        { src: "core:roles", agentId: runtime.agentId },
        "No worlds found for agent",
      );
    });

    it("should return null when no worlds match the owner", async () => {
      const mockWorlds: World[] = [
        {
          id: "world-1" as UUID,
          name: "World 1",
          agentId: runtime.agentId,
          messageServerId: "server-1",
          metadata: {
            ownership: {
              ownerId: "other-user-1",
            },
          },
        },
        {
          id: "world-2" as UUID,
          name: "World 2",
          agentId: runtime.agentId,
          messageServerId: "server-2",
          metadata: {
            ownership: {
              ownerId: "other-user-2",
            },
          },
        },
      ];

      vi.spyOn(runtime, "getAllWorlds").mockResolvedValue(mockWorlds);

      const result = await findWorldsForOwner(runtime, "user-123");

      expect(result).toBeNull();
    });

    it("should handle worlds without metadata", async () => {
      const mockWorlds: World[] = [
        {
          id: "world-1" as UUID,
          name: "World 1",
          agentId: runtime.agentId,
          messageServerId: "server-1",
          metadata: {},
        },
        {
          id: "world-2" as UUID,
          name: "World 2",
          agentId: runtime.agentId,
          messageServerId: "server-2",
        } as World,
      ];

      vi.spyOn(runtime, "getAllWorlds").mockResolvedValue(mockWorlds);

      const result = await findWorldsForOwner(runtime, "user-123");

      expect(result).toBeNull();
    });

    it("should handle worlds without ownership in metadata", async () => {
      const mockWorlds: World[] = [
        {
          id: "world-1" as UUID,
          name: "World 1",
          agentId: runtime.agentId,
          messageServerId: "server-1",
          metadata: {
            someOtherData: "value",
          },
        },
      ];

      vi.spyOn(runtime, "getAllWorlds").mockResolvedValue(mockWorlds);

      const result = await findWorldsForOwner(runtime, "user-123");

      expect(result).toBeNull();
    });
  });
});
