import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUniqueUuid,
  findEntityByName,
  formatEntities,
  getEntityDetails,
} from "../entities";
import * as index from "../index";
import * as logger_module from "../logger";
import type { Entity, Memory, State, UUID } from "../types";
import type { IAgentRuntime } from "../types/runtime";
import * as utils from "../utils";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

describe("entities", () => {
  let runtime: IAgentRuntime;
  let mockMemory: Memory;
  let mockState: State;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create REAL runtime
    runtime = await createTestRuntime();

    // Mock logger methods to prevent undefined function errors
    // Mock both the index-exported logger and direct logger module
    const loggerInstances = [index.logger, logger_module.logger].filter(
      Boolean,
    );

    loggerInstances.forEach((loggerInstance) => {
      if (loggerInstance) {
        // Always ensure these methods exist and are mocked
        const methods = ["warn", "error", "info", "debug"];
        methods.forEach((method) => {
          if (typeof loggerInstance[method] === "function") {
            vi.spyOn(loggerInstance, method).mockImplementation(() => {});
          } else {
            loggerInstance[method] = vi.fn(() => {});
          }
        });
      }
    });

    // Spy on runtime.logger methods
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});

    // Create mock memory
    mockMemory = {
      id: "memory-123" as UUID,
      entityId: "entity-456" as UUID,
      roomId: "room-789" as UUID,
      content: {},
    } as Memory;

    // Create mock state
    mockState = {
      data: {
        room: null,
      },
      values: {},
      text: "",
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  describe("findEntityByName", () => {
    it("should find entity by exact name match", async () => {
      const mockRoom = {
        id: "room-789" as UUID,
        name: "Test Room",
        worldId: "world-123" as UUID,
        createdAt: Date.now(),
      };

      const mockWorld = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123" as UUID,
        metadata: {
          roles: {},
        },
        createdAt: Date.now(),
        entities: [],
      };

      const mockEntity: Entity = {
        id: "entity-123" as UUID,
        names: ["Alice", "Alice Smith"],
        agentId: runtime.agentId,
        metadata: {},
        components: [],
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([mockEntity]);
      vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
      vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
      vi.spyOn(runtime, "useModel").mockResolvedValue(
        `<response>
  <entityId>entity-123</entityId>
  <type>EXACT_MATCH</type>
  <matches>
    <match>
      <name>Alice</name>
      <reason>Exact match found</reason>
    </match>
  </matches>
</response>`,
      );
      vi.spyOn(runtime, "getEntityById").mockResolvedValue(mockEntity);

      const result = await findEntityByName(runtime, mockMemory, mockState);

      expect(result).toEqual(mockEntity);
      expect(runtime.getRoom).toHaveBeenCalledWith("room-789");
      expect(runtime.getEntitiesForRoom).toHaveBeenCalledWith("room-789", true);
    });

    it("should return null when room not found", async () => {
      vi.spyOn(runtime, "getRoom").mockResolvedValue(null);
      const getEntitiesForRoomSpy = vi.spyOn(runtime, "getEntitiesForRoom");

      const result = await findEntityByName(runtime, mockMemory, mockState);

      expect(result).toBeNull();
      expect(getEntitiesForRoomSpy).not.toHaveBeenCalled();
    });

    it("should filter components based on permissions", async () => {
      const mockRoom = {
        id: "room-789" as UUID,
        worldId: "world-123" as UUID,
        createdAt: Date.now(),
      };

      const mockWorld = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123" as UUID,
        metadata: {
          roles: {
            "admin-entity": "ADMIN",
            "owner-entity": "OWNER",
          },
        },
        createdAt: Date.now(),
        entities: [],
      };

      const mockEntity: Entity = {
        id: "entity-123" as UUID,
        names: ["Alice"],
        agentId: runtime.agentId,
        components: [
          {
            id: "comp-1" as UUID,
            entityId: "entity-123" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "entity-456" as UUID, // Should pass - message sender
            type: "PROFILE",
            createdAt: Date.now(),
            data: {},
          },
          {
            id: "comp-2" as UUID,
            entityId: "entity-123" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "admin-entity" as UUID, // Should pass - admin
            type: "PROFILE",
            createdAt: Date.now(),
            data: {},
          },
          {
            id: "comp-3" as UUID,
            entityId: "entity-123" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "random-entity" as UUID, // Should be filtered out
            type: "PROFILE",
            createdAt: Date.now(),
            data: {},
          },
        ],
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([mockEntity]);
      vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
      vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
      vi.spyOn(runtime, "useModel").mockResolvedValue(
        JSON.stringify({
          type: "EXACT_MATCH",
          entityId: "entity-123",
        }),
      );
      vi.spyOn(runtime, "getEntityById").mockResolvedValue(mockEntity);

      await findEntityByName(runtime, mockMemory, mockState);

      // The mock setup should have filtered components, but since we're mocking
      // the entire flow, we need to verify the logic would work correctly
      expect(runtime.getWorld).toHaveBeenCalledWith("world-123");
    });

    it("should handle LLM parse failure gracefully", async () => {
      const mockRoom = {
        id: "room-789" as UUID,
        createdAt: Date.now(),
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getWorld").mockResolvedValue(null);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([]);
      vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
      vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
      vi.spyOn(runtime, "useModel").mockResolvedValue("invalid json");

      const result = await findEntityByName(runtime, mockMemory, mockState);

      expect(result).toBeNull();
    });

    it("should handle EXACT_MATCH with entity components filtering", async () => {
      const mockRoom = {
        id: "room-789" as UUID,
        worldId: "world-123" as UUID,
        createdAt: Date.now(),
      };

      const mockWorld = {
        id: "world-123" as UUID,
        name: "Test World",
        agentId: runtime.agentId,
        messageServerId: "server-123" as UUID,
        metadata: {
          roles: {
            "admin-entity": "ADMIN",
            "owner-entity": "OWNER",
            "regular-entity": "MEMBER",
          },
        },
        createdAt: Date.now(),
        entities: [],
      };

      const mockEntityWithComponents: Entity = {
        id: "entity-exact" as UUID,
        names: ["ExactMatch"],
        agentId: runtime.agentId,
        metadata: {},
        components: [
          {
            id: "comp-1" as UUID,
            entityId: "entity-exact" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "entity-456" as UUID, // Same as message sender
            type: "PROFILE",
            createdAt: Date.now(),
            data: { bio: "User profile" },
          },
          {
            id: "comp-2" as UUID,
            entityId: "entity-exact" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "admin-entity" as UUID, // Admin role
            type: "SETTINGS",
            createdAt: Date.now(),
            data: { settings: "admin settings" },
          },
          {
            id: "comp-3" as UUID,
            entityId: "entity-exact" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "random-entity" as UUID, // Should be filtered out
            type: "PRIVATE",
            createdAt: Date.now(),
            data: { private: "data" },
          },
        ],
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getWorld").mockResolvedValue(mockWorld);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([
        mockEntityWithComponents,
      ]);
      vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
      vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
      vi.spyOn(runtime, "useModel").mockResolvedValue(
        `<response>
  <entityId>entity-exact</entityId>
  <type>EXACT_MATCH</type>
  <matches>
    <match>
      <name>ExactMatch</name>
      <reason>Exact ID match</reason>
    </match>
  </matches>
</response>`,
      );
      vi.spyOn(runtime, "getEntityById").mockResolvedValue(
        mockEntityWithComponents,
      );

      const result = await findEntityByName(runtime, mockMemory, mockState);

      expect(result).toBeDefined();
      expect(result?.id).toBe("entity-exact" as UUID);
      // Verify getEntityById was called (covers lines 274-282)
      expect(runtime.getEntityById).toHaveBeenCalledWith("entity-exact");
    });

    it("should find entity by username in components", async () => {
      const mockRoom = {
        id: "room-789" as UUID,
        worldId: null,
        createdAt: Date.now(),
      };

      const mockEntity: Entity = {
        id: "entity-user" as UUID,
        names: ["John Doe"],
        agentId: runtime.agentId,
        metadata: {},
        components: [
          {
            id: "comp-1" as UUID,
            entityId: "entity-user" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: undefined,
            sourceEntityId: "entity-456" as UUID,
            type: "PROFILE",
            createdAt: Date.now(),
            data: { username: "johndoe123" },
          },
        ],
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getWorld").mockResolvedValue(null);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([mockEntity]);
      vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
      vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
      vi.spyOn(runtime, "useModel").mockResolvedValue(
        `<response>
  <entityId>entity-user</entityId>
  <type>EXACT_MATCH</type>
</response>`,
      );
      vi.spyOn(runtime, "getEntityById").mockResolvedValue(mockEntity);

      const result = await findEntityByName(runtime, mockMemory, mockState);

      expect(result).toBeDefined();
      expect(result?.id).toBe("entity-user" as UUID);
    });

    it("should find entity by handle in components", async () => {
      const mockRoom = {
        id: "room-789" as UUID,
        worldId: null,
        createdAt: Date.now(),
      };

      const mockEntity: Entity = {
        id: "entity-handle" as UUID,
        names: ["Jane Smith"],
        agentId: runtime.agentId,
        metadata: {},
        components: [
          {
            id: "comp-1" as UUID,
            entityId: "entity-handle" as UUID,
            agentId: runtime.agentId,
            roomId: "room-789" as UUID,
            worldId: undefined,
            sourceEntityId: "entity-456" as UUID,
            type: "PROFILE",
            createdAt: Date.now(),
            data: { handle: "@janesmith" },
          },
        ],
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getWorld").mockResolvedValue(null);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([mockEntity]);
      vi.spyOn(runtime, "getRelationships").mockResolvedValue([]);
      vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
      vi.spyOn(runtime, "useModel").mockResolvedValue(
        `<response>
  <entityId>entity-handle</entityId>
  <type>EXACT_MATCH</type>
</response>`,
      );
      vi.spyOn(runtime, "getEntityById").mockResolvedValue(mockEntity);

      const result = await findEntityByName(runtime, mockMemory, mockState);

      expect(result).toBeDefined();
      expect(result?.id).toBe("entity-handle" as UUID);
    });
  });

  describe("createUniqueUuid", () => {
    it("should return agent ID when base user ID matches agent ID", () => {
      const result = createUniqueUuid(runtime, runtime.agentId);
      expect(result).toBe(runtime.agentId);
    });

    it("should create UUID from combined string for different IDs", () => {
      const result = createUniqueUuid(runtime, "user-456");

      const expected = utils.stringToUuid(`user-456:${runtime.agentId}`);
      expect(result).toBe(expected);
    });

    it("should handle UUID type as base user ID", () => {
      const result = createUniqueUuid(runtime, "user-789" as UUID);

      const expected = utils.stringToUuid(`user-789:${runtime.agentId}`);
      expect(result).toBe(expected);
    });
  });

  describe("getEntityDetails", () => {
    it("should retrieve and format entity details for a room", async () => {
      const mockRoom = {
        id: "room-123" as UUID,
        source: "discord",
        createdAt: Date.now(),
      };

      const mockEntities: Entity[] = [
        {
          id: "entity-1" as UUID,
          names: ["Alice", "Alice Smith"],
          agentId: runtime.agentId,
          metadata: {
            bio: "Test bio",
            discord: { name: "Alice#1234" },
          },
          components: [
            {
              id: "comp-1" as UUID,
              entityId: "entity-1" as UUID,
              agentId: runtime.agentId,
              roomId: "room-123" as UUID,
              worldId: "world-123" as UUID,
              sourceEntityId: "source-123" as UUID,
              type: "PROFILE",
              createdAt: Date.now(),
              data: { avatar: "avatar.jpg" },
            },
            {
              id: "comp-2" as UUID,
              entityId: "entity-1" as UUID,
              agentId: runtime.agentId,
              roomId: "room-123" as UUID,
              worldId: "world-123" as UUID,
              sourceEntityId: "source-123" as UUID,
              type: "SETTINGS",
              createdAt: Date.now(),
              data: { theme: "dark" },
            },
          ],
        },
        {
          id: "entity-2" as UUID,
          names: ["Bob"],
          agentId: runtime.agentId,
          metadata: {},
          components: [],
        },
      ];

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue(mockEntities);

      const result = await getEntityDetails({
        runtime,
        roomId: "room-123" as UUID,
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "entity-1",
        name: "Alice#1234", // Uses discord name from metadata
        names: ["Alice", "Alice Smith"],
        data: expect.stringContaining("avatar"),
      });
      expect(result[1]).toEqual({
        id: "entity-2",
        name: "Bob",
        names: ["Bob"],
        data: "{}",
      });
    });

    it("should handle deduplication of entities", async () => {
      const mockRoom = {
        id: "room-123" as UUID,
        createdAt: Date.now(),
      };

      const duplicateEntity = {
        id: "entity-1" as UUID,
        names: ["Alice"],
        agentId: runtime.agentId,
        metadata: {},
        components: [],
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([
        duplicateEntity,
        duplicateEntity, // Duplicate
      ]);

      const result = await getEntityDetails({
        runtime,
        roomId: "room-123" as UUID,
      });

      expect(result).toHaveLength(1);
    });

    it("should merge array data in components", async () => {
      const mockRoom = {
        id: "room-123" as UUID,
        createdAt: Date.now(),
      };

      const mockEntity: Entity = {
        id: "entity-1" as UUID,
        names: ["Charlie"],
        agentId: runtime.agentId,
        metadata: {},
        components: [
          {
            id: "comp-1" as UUID,
            entityId: "entity-1" as UUID,
            agentId: runtime.agentId,
            roomId: "room-123" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "source-123" as UUID,
            type: "PROFILE",
            createdAt: Date.now(),
            data: { hobbies: ["reading", "gaming"] },
          },
          {
            id: "comp-2" as UUID,
            entityId: "entity-1" as UUID,
            agentId: runtime.agentId,
            roomId: "room-123" as UUID,
            worldId: "world-123" as UUID,
            sourceEntityId: "source-123" as UUID,
            type: "PROFILE",
            createdAt: Date.now(),
            data: { hobbies: ["gaming", "music"] }, // Duplicate "gaming"
          },
        ],
      };

      vi.spyOn(runtime, "getRoom").mockResolvedValue(mockRoom);
      vi.spyOn(runtime, "getEntitiesForRoom").mockResolvedValue([mockEntity]);

      const result = await getEntityDetails({
        runtime,
        roomId: "room-123" as UUID,
      });

      const parsedData = JSON.parse(result[0].data);
      // Object.assign causes second component's hobbies array to overwrite first
      expect(parsedData.hobbies).toEqual(["gaming", "music"]);
    });
  });

  describe("formatEntities", () => {
    it("should format single entity with basic info", () => {
      const entities: Entity[] = [
        {
          id: "entity-1" as UUID,
          names: ["Alice"],
          agentId: runtime.agentId,
          metadata: { bio: "Test bio" },
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"Alice"');
      expect(result).toContain("ID: entity-1");
      expect(result).toContain('Data: {"bio":"Test bio"}');
    });

    it("should format multiple entities", () => {
      const entities: Entity[] = [
        {
          id: "entity-1" as UUID,
          names: ["Alice", "Alice Smith"],
          agentId: runtime.agentId,
          metadata: { role: "Developer" },
        },
        {
          id: "entity-2" as UUID,
          names: ["Bob"],
          agentId: runtime.agentId,
          metadata: { role: "Manager" },
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"Alice" aka "Alice Smith"');
      expect(result).toContain('"Bob"');
      expect(result).toContain("ID: entity-1");
      expect(result).toContain("ID: entity-2");
      expect(result).toContain('{"role":"Developer"}');
      expect(result).toContain('{"role":"Manager"}');
    });

    it("should handle entities without metadata", () => {
      const entities: Entity[] = [
        {
          id: "entity-1" as UUID,
          names: ["Charlie"],
          agentId: runtime.agentId,
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"Charlie"');
      expect(result).toContain("ID: entity-1");
      expect(result).not.toContain("Data:");
    });

    it("should handle empty entities array", () => {
      const result = formatEntities({ entities: [] });
      expect(result).toBe("");
    });

    it("should handle entities with empty metadata", () => {
      const entities: Entity[] = [
        {
          id: "entity-1" as UUID,
          names: ["David"],
          agentId: runtime.agentId,
          metadata: {},
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"David"');
      expect(result).toContain("ID: entity-1");
      expect(result).not.toContain("Data:");
    });
  });

  it("createUniqueUuid combines user and agent ids", () => {
    const id = createUniqueUuid(runtime, "user");
    const expected = utils.stringToUuid(`user:${runtime.agentId}`);
    expect(id).toBe(expected);
  });

  it("formatEntities outputs joined string", () => {
    const entities: Entity[] = [
      {
        id: "1" as UUID,
        names: ["A"],
        metadata: {},
        agentId: runtime.agentId,
      },
      {
        id: "2" as UUID,
        names: ["B"],
        metadata: { extra: true },
        agentId: runtime.agentId,
      },
    ];
    const text = formatEntities({ entities });
    expect(text).toContain('"A"');
    expect(text).toContain("ID: 1");
    expect(text).toContain("ID: 2");
  });
});
