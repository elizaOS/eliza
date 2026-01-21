import { beforeEach, describe, expect, it } from "bun:test";
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import type { JsonValue } from "../../../types/common";
import { sendToAdminAction } from "../src/action";
import { autonomyPlugin } from "../src/index";
import { adminChatProvider } from "../src/provider";
import { AutonomyService } from "../src/service";
import { autonomyStatusProvider } from "../src/status-provider";

// Partial mock type for IAgentRuntime in tests
type MockAgentRuntime = Partial<IAgentRuntime> & {
  character: {
    name: string;
    bio: string[];
    settings?: Record<
      string,
      string | number | boolean | Record<string, JsonValue>
    >;
  };
  agentId: UUID;
  getSetting: (key: string) => JsonValue | undefined;
  setSetting: (key: string, value: JsonValue) => void;
  updateAgent: (
    agentId: UUID,
    updates: Record<string, JsonValue>,
  ) => Promise<boolean>;
  getService: (serviceName: string) => {
    getAutonomousRoomId: () => UUID;
    isLoopRunning: () => boolean;
    getLoopInterval: () => number;
  } | null;
};

describe("Autonomy Plugin Tests", () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  interface UpdateAgentCall {
    agentId: UUID;
    updates: Record<string, JsonValue>;
  }
  let updateAgentCalls: UpdateAgentCall[] = [];

  beforeEach(() => {
    updateAgentCalls = [];
    const dynamicSettings = {
      ADMIN_USER_ID: "a1b2c3d4-5678-4abc-b123-123456789012",
      AUTONOMY_ENABLED: false,
    };

    mockRuntime = {
      character: {
        name: "TestAgent",
        bio: ["Test agent for autonomy plugin"],
        settings: {},
      },
      agentId: "12345678-1234-4567-8901-123456789012" as UUID,
      getSetting: (key: string) => {
        return dynamicSettings[key as keyof typeof dynamicSettings];
      },
      setSetting: (key: string, value: JsonValue) => {
        mockRuntime.character.settings = mockRuntime.character.settings || {};
        if (value !== null) {
          mockRuntime.character.settings[key] = value as
            | string
            | number
            | boolean
            | Record<string, JsonValue>;
        }
        (dynamicSettings as Record<string, JsonValue>)[key] = value; // Update dynamic settings
      },
      updateAgent: async (
        agentId: UUID,
        updates: Record<string, JsonValue>,
      ) => {
        updateAgentCalls.push({ agentId, updates });
        return true;
      },
      getMemories: async (_params: Record<string, JsonValue>) => [],
      createMemory: async () => "test-memory-id" as UUID,
      createRoom: async () => {},
      getRoom: async () => null,
      sendMessageToTarget: async () => {},
      getService: (serviceName: string) => {
        if (serviceName === "AUTONOMY" || serviceName === "autonomy") {
          return {
            getAutonomousRoomId: () => "autonomous-room-id" as UUID,
            isLoopRunning: () => false,
            getLoopInterval: () => 30000,
          };
        }
        return null;
      },
      processMessage: async () => {},
    } as MockAgentRuntime as IAgentRuntime;

    mockMessage = {
      id: "test-msg-id" as UUID,
      entityId: "test-user-id" as UUID,
      roomId: "test-room-id" as UUID,
      content: { text: "Test message" },
    } as Memory;

    mockState = {
      values: {},
      data: {},
      text: "",
    };
  });

  describe("Plugin Structure Tests", () => {
    it("should have correct plugin metadata", () => {
      expect(autonomyPlugin.name).toBe("autonomy");
      expect(autonomyPlugin.description).toContain("autonomous");
      expect(autonomyPlugin.services).toBeDefined();
      expect(autonomyPlugin.actions).toBeDefined();
      expect(autonomyPlugin.providers).toBeDefined();
    });

    it("should export required components", () => {
      expect(autonomyPlugin.services).toHaveLength(1);
      expect(autonomyPlugin.actions).toHaveLength(1);
      expect(autonomyPlugin.providers).toHaveLength(2); // adminChatProvider + autonomyStatusProvider
    });

    it("should have the correct service", () => {
      const service = autonomyPlugin.services?.[0];
      expect(service).toBe(AutonomyService);
    });

    it("should have the correct actions", () => {
      const actionNames = autonomyPlugin.actions?.map((a) => a.name) || [];
      expect(actionNames).toContain("SEND_TO_ADMIN");
    });

    it("should have the correct providers", () => {
      const providerNames = autonomyPlugin.providers?.map((p) => p.name) || [];
      expect(providerNames).toContain("ADMIN_CHAT_HISTORY");
      expect(providerNames).toContain("AUTONOMY_STATUS");
    });
  });

  describe("AutonomyService Tests", () => {
    it("should be constructable", () => {
      expect(
        () => new AutonomyService(mockRuntime as IAgentRuntime),
      ).not.toThrow();
    });

    it("should have correct service metadata", () => {
      expect(AutonomyService.serviceType).toBe("AUTONOMOUS");
    });
  });

  describe("AdminChat Provider Tests", () => {
    it("should have correct metadata", () => {
      expect(adminChatProvider.name).toBe("ADMIN_CHAT_HISTORY");
      expect(adminChatProvider.description).toContain("conversation history");
    });

    it("should handle no admin configured in autonomous context", async () => {
      const runtimeWithoutAdmin = {
        ...mockRuntime,
        getSetting: () => null,
      };

      const autonomousMessage = {
        ...mockMessage,
        roomId: "autonomous-room-id" as UUID,
      };

      const result = await adminChatProvider.get(
        runtimeWithoutAdmin as IAgentRuntime,
        autonomousMessage,
        mockState,
      );

      expect(result.text).toContain("No admin user configured");
      expect(result.data?.adminConfigured).toBe(false);
    });

    it("should work when admin is configured in autonomous context", async () => {
      const autonomousMessage = {
        ...mockMessage,
        roomId: "autonomous-room-id" as UUID,
      };

      const result = await adminChatProvider.get(
        mockRuntime as IAgentRuntime,
        autonomousMessage,
        mockState,
      );

      // Since getMemories returns empty array, should get "no recent messages" message
      expect(result.text).toContain("No recent messages found");
      expect(result.data?.adminConfigured).toBe(true);
      expect(result.data?.adminUserId).toBe(
        "a1b2c3d4-5678-4abc-b123-123456789012",
      );
    });
  });

  describe("Send To Admin Action Tests", () => {
    it("should have correct metadata", () => {
      expect(sendToAdminAction.name).toBe("SEND_TO_ADMIN");
      expect(sendToAdminAction.description).toContain("Send");
      expect(sendToAdminAction.validate).toBeDefined();
      expect(sendToAdminAction.handler).toBeDefined();
    });

    it("should validate messages in autonomous context", async () => {
      const autonomousMessage = {
        ...mockMessage,
        roomId: "autonomous-room-id" as UUID,
        content: { text: "I need to tell the admin something" },
      };

      const isValid = await sendToAdminAction.validate(
        mockRuntime,
        autonomousMessage,
      );
      expect(isValid).toBe(true);
    });

    it("should reject messages outside autonomous context", async () => {
      const regularMessage = {
        ...mockMessage,
        roomId: "regular-room-id" as UUID,
        content: { text: "I need to tell the admin something" },
      };

      const isValid = await sendToAdminAction.validate(
        mockRuntime,
        regularMessage,
      );
      expect(isValid).toBe(false);
    });
  });

  describe("Plugin Integration Tests", () => {
    it("should have all components properly connected", () => {
      // Verify that all expected components are present
      expect(autonomyPlugin.services).toContain(AutonomyService);
      expect(autonomyPlugin.actions).toContain(sendToAdminAction);
      expect(autonomyPlugin.providers).toContain(adminChatProvider);
      expect(autonomyPlugin.providers).toContain(autonomyStatusProvider);
    });

    it("should have consistent naming", () => {
      expect(autonomyPlugin.name).toBe("autonomy");
      expect(AutonomyService.serviceType).toBe("AUTONOMOUS");
      expect(adminChatProvider.name).toBe("ADMIN_CHAT_HISTORY");
      expect(autonomyStatusProvider.name).toBe("AUTONOMY_STATUS");
      expect(sendToAdminAction.name).toBe("SEND_TO_ADMIN");
    });
  });

  describe("Autonomy Service Integration Tests", () => {
    it("should enable autonomy via settings", async () => {
      const service = new AutonomyService(mockRuntime);
      await service.initialize();

      // Enable autonomy
      await service.enableAutonomy();

      // Check that setting was updated
      expect(mockRuntime.character.settings?.AUTONOMY_ENABLED).toBe(true);

      // Check that loop is running
      expect(service.isLoopRunning()).toBe(true);

      // Clean up
      await service.stop();
    });

    it("should disable autonomy via settings", async () => {
      const service = new AutonomyService(mockRuntime);
      await service.initialize();

      // Enable first, then disable
      await service.enableAutonomy();
      await service.disableAutonomy();

      // Check that setting was updated
      expect(mockRuntime.character.settings?.AUTONOMY_ENABLED).toBe(false);

      // Check that loop is not running
      expect(service.isLoopRunning()).toBe(false);
    });

    it("should provide status information", async () => {
      const service = new AutonomyService(mockRuntime);
      await service.initialize();

      // Check initial status
      let status = service.getStatus();
      expect(status.enabled).toBe(false);
      expect(status.interval).toBe(1000);

      // Enable and check status
      await service.enableAutonomy();
      status = service.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(true);
      expect(status.interval).toBe(1000);

      // Clean up
      await service.stop();
    });

    it("should have correct autonomous room ID", async () => {
      const service = new AutonomyService(mockRuntime);
      await service.initialize();

      const roomId = service.getAutonomousRoomId();
      // Should be a valid UUID format
      expect(roomId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });
});
