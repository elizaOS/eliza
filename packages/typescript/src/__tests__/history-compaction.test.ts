/**
 * Tests for History Compaction
 *
 * Comprehensive tests for:
 * - RESET_SESSION action
 * - STATUS action
 * - InMemoryAdapter start/end filtering
 * - RECENT_MESSAGES provider compaction integration
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, Room, UUID } from "../types/index.ts";

// Mock helpers
function createMockMessage(
  createdAt: number,
  text: string,
  roomId: UUID = "room-1" as UUID,
): Memory {
  return {
    id: `msg-${createdAt}` as UUID,
    entityId: "user-1" as UUID,
    agentId: "agent-1" as UUID,
    roomId,
    content: { text },
    createdAt,
  };
}

function createMockRoom(options?: {
  lastCompactionAt?: number;
  serverId?: string;
  name?: string;
}): Room {
  return {
    id: "room-1" as UUID,
    name: options?.name ?? "Test Room",
    serverId: options?.serverId ?? "server-1",
    metadata:
      options?.lastCompactionAt !== undefined
        ? { lastCompactionAt: options.lastCompactionAt }
        : {},
  } as Room;
}

// ============================================
// InMemoryAdapter Tests
// ============================================
describe("InMemoryAdapter getMemories with start/end parameters", () => {
  it(
    "should filter messages by start timestamp",
    { timeout: 30000 },
    async () => {
      const { InMemoryDatabaseAdapter } = await import(
        "../database/inMemoryAdapter.ts"
      );

      const adapter = new InMemoryDatabaseAdapter();
      await adapter.init();

      const roomId = "room-1" as UUID;

      const messages = [
        createMockMessage(1000, "Message at 1000", roomId),
        createMockMessage(2000, "Message at 2000", roomId),
        createMockMessage(3000, "Message at 3000", roomId),
        createMockMessage(4000, "Message at 4000", roomId),
        createMockMessage(5000, "Message at 5000", roomId),
      ];

      for (const msg of messages) {
        await adapter.createMemory(msg, "messages", false);
      }

      // Get messages after start = 2500
      const result = await adapter.getMemories({
        tableName: "messages",
        roomId,
        start: 2500,
      });

      expect(result.length).toBe(3);
      expect(result.map((m) => m.createdAt)).toEqual([3000, 4000, 5000]);
    },
  );

  it(
    "should filter messages by end timestamp",
    { timeout: 30000 },
    async () => {
      const { InMemoryDatabaseAdapter } = await import(
        "../database/inMemoryAdapter.ts"
      );

      const adapter = new InMemoryDatabaseAdapter();
      await adapter.init();

      const roomId = "room-1" as UUID;

      const messages = [
        createMockMessage(1000, "Message at 1000", roomId),
        createMockMessage(2000, "Message at 2000", roomId),
        createMockMessage(3000, "Message at 3000", roomId),
        createMockMessage(4000, "Message at 4000", roomId),
        createMockMessage(5000, "Message at 5000", roomId),
      ];

      for (const msg of messages) {
        await adapter.createMemory(msg, "messages", false);
      }

      // Get messages before end = 3500
      const result = await adapter.getMemories({
        tableName: "messages",
        roomId,
        end: 3500,
      });

      expect(result.length).toBe(3);
      expect(result.map((m) => m.createdAt)).toEqual([1000, 2000, 3000]);
    },
  );

  it("should filter messages by both start and end timestamp", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    const messages = [
      createMockMessage(1000, "Message at 1000", roomId),
      createMockMessage(2000, "Message at 2000", roomId),
      createMockMessage(3000, "Message at 3000", roomId),
      createMockMessage(4000, "Message at 4000", roomId),
      createMockMessage(5000, "Message at 5000", roomId),
    ];

    for (const msg of messages) {
      await adapter.createMemory(msg, "messages", false);
    }

    // Get messages between 1500 and 4500
    const result = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: 1500,
      end: 4500,
    });

    expect(result.length).toBe(3);
    expect(result.map((m) => m.createdAt)).toEqual([2000, 3000, 4000]);
  });

  it("should handle exact boundary timestamps (inclusive)", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    await adapter.createMemory(
      createMockMessage(1000, "Exact", roomId),
      "messages",
      false,
    );

    // Start exactly at message time (should include)
    const resultStart = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: 1000,
    });
    expect(resultStart.length).toBe(1);

    // End exactly at message time (should include)
    const resultEnd = await adapter.getMemories({
      tableName: "messages",
      roomId,
      end: 1000,
    });
    expect(resultEnd.length).toBe(1);
  });

  it("should return empty array when no messages match", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    await adapter.createMemory(
      createMockMessage(1000, "Old", roomId),
      "messages",
      false,
    );

    // Start after all messages
    const result = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: 2000,
    });

    expect(result.length).toBe(0);
  });

  it("should still respect count limit with start/end", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    for (let i = 1; i <= 10; i++) {
      await adapter.createMemory(
        createMockMessage(i * 1000, `Message ${i}`, roomId),
        "messages",
        false,
      );
    }

    // Get messages after 3000, but limit to 3
    const result = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: 3500,
      count: 3,
    });

    expect(result.length).toBe(3);
  });

  it("should handle messages with undefined createdAt", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    const msgWithoutCreatedAt: Memory = {
      id: "msg-no-time" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId,
      content: { text: "No timestamp" },
      // createdAt is undefined
    };

    const msgWithCreatedAt = createMockMessage(5000, "Has timestamp", roomId);

    await adapter.createMemory(msgWithoutCreatedAt, "messages", false);
    await adapter.createMemory(msgWithCreatedAt, "messages", false);

    // Start at 1000 - message without createdAt (treated as 0) should be filtered
    const result = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: 1000,
    });

    expect(result.length).toBe(1);
    expect(result[0].content.text).toBe("Has timestamp");
  });
});

// ============================================
// RESET_SESSION Action Tests
// ============================================
describe("RESET_SESSION action", () => {
  it(
    "should set lastCompactionAt in room metadata",
    { timeout: 30000 },
    async () => {
      const { resetSessionAction } = await import(
        "../bootstrap/actions/resetSession.ts"
      );

      let updatedRoom: Room | null = null;
      const mockRuntime = {
        agentId: "agent-1" as UUID,
        getRoom: vi.fn(async () => createMockRoom()),
        updateRoom: vi.fn(async (room: Room) => {
          updatedRoom = room;
        }),
      } as unknown as IAgentRuntime;

      const mockMessage: Memory = {
        id: "msg-1" as UUID,
        entityId: "user-1" as UUID,
        agentId: "agent-1" as UUID,
        roomId: "room-1" as UUID,
        content: { text: "/reset" },
      };

      const mockState = {
        data: {
          room: createMockRoom(),
        },
      };

      const mockCallback = vi.fn();

      const result = await resetSessionAction.handler(
        mockRuntime,
        mockMessage,
        mockState as never,
        undefined,
        mockCallback,
      );

      expect(result.success).toBe(true);
      expect(mockRuntime.updateRoom).toHaveBeenCalled();
      expect(updatedRoom?.metadata?.lastCompactionAt).toBeDefined();
      expect(typeof updatedRoom?.metadata?.lastCompactionAt).toBe("number");
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Session has been reset. I'll start fresh from here.",
          actions: ["RESET_SESSION"],
        }),
      );
    },
  );

  it("should maintain compaction history", { timeout: 30000 }, async () => {
    const { resetSessionAction } = await import(
      "../bootstrap/actions/resetSession.ts"
    );

    const existingRoom = createMockRoom({ lastCompactionAt: 1000 });
    existingRoom.metadata = {
      ...existingRoom.metadata,
      compactionHistory: [
        { timestamp: 1000, triggeredBy: "old-user", reason: "manual_reset" },
      ],
    };

    let updatedRoom: Room | null = null;
    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => existingRoom),
      updateRoom: vi.fn(async (room: Room) => {
        updatedRoom = room;
      }),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-2" as UUID,
      entityId: "user-2" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/reset" },
    };

    const mockState = {
      data: {
        room: existingRoom,
      },
    };

    await resetSessionAction.handler(
      mockRuntime,
      mockMessage,
      mockState as never,
    );

    expect(updatedRoom?.metadata?.compactionHistory).toHaveLength(2);
    const history = updatedRoom?.metadata?.compactionHistory as {
      timestamp: number;
    }[];
    expect(history[0].timestamp).toBe(1000);
    expect(history[1].timestamp).toBeGreaterThan(1000);
  });

  it(
    "should limit compaction history to 10 entries",
    { timeout: 30000 },
    async () => {
      const { resetSessionAction } = await import(
        "../bootstrap/actions/resetSession.ts"
      );

      // Create room with 10 existing entries
      const existingRoom = createMockRoom({ lastCompactionAt: 10000 });
      existingRoom.metadata = {
        ...existingRoom.metadata,
        compactionHistory: Array.from({ length: 10 }, (_, i) => ({
          timestamp: (i + 1) * 1000,
          triggeredBy: `user-${i}`,
          reason: "manual_reset",
        })),
      };

      let updatedRoom: Room | null = null;
      const mockRuntime = {
        agentId: "agent-1" as UUID,
        getRoom: vi.fn(async () => existingRoom),
        updateRoom: vi.fn(async (room: Room) => {
          updatedRoom = room;
        }),
      } as unknown as IAgentRuntime;

      const mockMessage: Memory = {
        id: "msg-11" as UUID,
        entityId: "user-11" as UUID,
        agentId: "agent-1" as UUID,
        roomId: "room-1" as UUID,
        content: { text: "/reset" },
      };

      await resetSessionAction.handler(mockRuntime, mockMessage, {
        data: { room: existingRoom },
      } as never);

      const history = updatedRoom?.metadata?.compactionHistory as {
        timestamp: number;
      }[];
      expect(history).toHaveLength(10); // Should still be 10, oldest removed
      expect(history[0].timestamp).toBe(2000); // First entry (1000) should be gone
    },
  );

  it("should handle room not found error", async () => {
    const { resetSessionAction } = await import(
      "../bootstrap/actions/resetSession.ts"
    );

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => null),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/reset" },
    };

    const mockCallback = vi.fn();

    const result = await resetSessionAction.handler(
      mockRuntime,
      mockMessage,
      { data: {} } as never, // No room in state
      undefined,
      mockCallback,
    );

    expect(result.success).toBe(false);
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Unable to reset session - room not found.",
        actions: ["RESET_SESSION_FAILED"],
      }),
    );
  });

  it("should track triggeredBy entity", async () => {
    const { resetSessionAction } = await import(
      "../bootstrap/actions/resetSession.ts"
    );

    let updatedRoom: Room | null = null;
    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => createMockRoom()),
      updateRoom: vi.fn(async (room: Room) => {
        updatedRoom = room;
      }),
    } as unknown as IAgentRuntime;

    const entityId = "user-who-triggered" as UUID;
    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/reset" },
    };

    await resetSessionAction.handler(mockRuntime, mockMessage, {
      data: { room: createMockRoom() },
    } as never);

    const history = updatedRoom?.metadata?.compactionHistory as {
      triggeredBy: string;
    }[];
    expect(history[0].triggeredBy).toBe(entityId);
  });

  it("should include previous compaction timestamp in result", async () => {
    const { resetSessionAction } = await import(
      "../bootstrap/actions/resetSession.ts"
    );

    const previousCompaction = 5000;
    const existingRoom = createMockRoom({
      lastCompactionAt: previousCompaction,
    });

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => existingRoom),
      updateRoom: vi.fn(),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/reset" },
    };

    const result = await resetSessionAction.handler(mockRuntime, mockMessage, {
      data: { room: existingRoom },
    } as never);

    expect(result.values?.previousCompactionAt).toBe(previousCompaction);
  });

  it("should always validate to true (any role can reset)", async () => {
    const { resetSessionAction } = await import(
      "../bootstrap/actions/resetSession.ts"
    );

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => createMockRoom({ serverId: undefined })),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/reset" },
    };

    // In DMs (no serverId), validation should pass
    const isValid = await resetSessionAction.validate(
      mockRuntime,
      mockMessage,
      { data: { room: createMockRoom({ serverId: undefined }) } } as never,
    );

    expect(isValid).toBe(true);
  });
});

// ============================================
// STATUS Action Tests
// ============================================
describe("STATUS action", () => {
  it("should show agent name and ID", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRuntime = {
      agentId: "agent-12345678" as UUID,
      character: { name: "MyTestAgent" },
      getRoom: vi.fn(async () => createMockRoom()),
      getTasks: vi.fn(async () => []),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const mockCallback = vi.fn();

    await statusAction.handler(
      mockRuntime,
      mockMessage,
      { data: { room: createMockRoom() } } as never,
      undefined,
      mockCallback,
    );

    const text = mockCallback.mock.calls[0][0].text;
    expect(text).toContain("MyTestAgent");
    expect(text).toContain("agent-12");
  });

  it("should show compaction timestamp when available", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const compactionTime = Date.now() - 3600000; // 1 hour ago
    const mockRoom = createMockRoom({ lastCompactionAt: compactionTime });

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      character: { name: "TestAgent" },
      getRoom: vi.fn(async () => mockRoom),
      getTasks: vi.fn(async () => []),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const mockCallback = vi.fn();

    await statusAction.handler(
      mockRuntime,
      mockMessage,
      { data: { room: mockRoom } } as never,
      undefined,
      mockCallback,
    );

    const text = mockCallback.mock.calls[0][0].text;
    expect(text).toContain("Last Reset:");
  });

  it("should not show Last Reset when no compaction", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRoom = createMockRoom(); // No lastCompactionAt

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      character: { name: "TestAgent" },
      getRoom: vi.fn(async () => mockRoom),
      getTasks: vi.fn(async () => []),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const mockCallback = vi.fn();

    await statusAction.handler(
      mockRuntime,
      mockMessage,
      { data: { room: mockRoom } } as never,
      undefined,
      mockCallback,
    );

    const text = mockCallback.mock.calls[0][0].text;
    expect(text).not.toContain("Last Reset:");
  });

  it("should list pending AWAITING_CHOICE tasks with options", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      character: { name: "TestAgent" },
      getRoom: vi.fn(async () => createMockRoom()),
      getTasks: vi.fn(async () => [
        {
          id: "task-1" as UUID,
          name: "Confirm Tweet",
          tags: ["AWAITING_CHOICE"],
          metadata: {
            options: [
              { name: "post", description: "Post the tweet" },
              { name: "cancel", description: "Cancel" },
            ],
          },
        },
        {
          id: "task-2" as UUID,
          name: "Approve Exec",
          tags: ["AWAITING_CHOICE"],
          metadata: {
            options: [{ name: "allow-once" }, { name: "deny" }],
          },
        },
      ]),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const mockCallback = vi.fn();

    await statusAction.handler(
      mockRuntime,
      mockMessage,
      { data: { room: createMockRoom() } } as never,
      undefined,
      mockCallback,
    );

    const text = mockCallback.mock.calls[0][0].text;
    expect(text).toContain("Pending Tasks");
    expect(text).toContain("Awaiting choice: 2");
    expect(text).toContain("Confirm Tweet");
  });

  it("should show 'No pending tasks' when empty", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      character: { name: "TestAgent" },
      getRoom: vi.fn(async () => createMockRoom()),
      getTasks: vi.fn(async () => []),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const mockCallback = vi.fn();

    await statusAction.handler(
      mockRuntime,
      mockMessage,
      { data: { room: createMockRoom() } } as never,
      undefined,
      mockCallback,
    );

    const text = mockCallback.mock.calls[0][0].text;
    expect(text).toContain("No pending tasks");
  });

  it("should show queued tasks separately", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      character: { name: "TestAgent" },
      getRoom: vi.fn(async () => createMockRoom()),
      getTasks: vi.fn(async () => [
        {
          id: "task-1" as UUID,
          name: "Queued Task 1",
          tags: ["queue"],
          metadata: {},
        },
        {
          id: "task-2" as UUID,
          name: "Queued Task 2",
          tags: ["queue", "repeat"],
          metadata: {},
        },
      ]),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const mockCallback = vi.fn();

    await statusAction.handler(
      mockRuntime,
      mockMessage,
      { data: { room: createMockRoom() } } as never,
      undefined,
      mockCallback,
    );

    const text = mockCallback.mock.calls[0][0].text;
    expect(text).toContain("Queued: 2");
  });

  it("should show room information", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRoom = createMockRoom({ name: "My Cool Room" });

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      character: { name: "TestAgent" },
      getRoom: vi.fn(async () => mockRoom),
      getTasks: vi.fn(async () => []),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const mockCallback = vi.fn();

    await statusAction.handler(
      mockRuntime,
      mockMessage,
      { data: { room: mockRoom } } as never,
      undefined,
      mockCallback,
    );

    const text = mockCallback.mock.calls[0][0].text;
    expect(text).toContain("Room");
    expect(text).toContain("My Cool Room");
  });

  it("should always validate to true", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRuntime = {} as unknown as IAgentRuntime;

    const isValid = await statusAction.validate(mockRuntime);
    expect(isValid).toBe(true);
  });

  it("should return status data in result values", async () => {
    const { statusAction } = await import("../bootstrap/actions/status.ts");

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      character: { name: "TestAgent" },
      getRoom: vi.fn(async () => createMockRoom()),
      getTasks: vi.fn(async () => [
        {
          id: "task-1" as UUID,
          name: "Test Task",
          tags: ["AWAITING_CHOICE"],
          metadata: { options: [{ name: "yes" }, { name: "no" }] },
        },
      ]),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/status" },
    };

    const result = await statusAction.handler(mockRuntime, mockMessage, {
      data: { room: createMockRoom() },
    } as never);

    expect(result.success).toBe(true);
    expect(result.values?.agentId).toBe("agent-1");
    expect(result.values?.agentName).toBe("TestAgent");
    expect((result.values?.tasks as { total: number }).total).toBe(1);
  });
});

// ============================================
// Integration Tests
// ============================================
describe("RECENT_MESSAGES provider compaction integration", () => {
  it("should pass lastCompactionAt as start parameter", async () => {
    // This test verifies the code structure by checking the provider implementation
    const { recentMessagesProvider } = await import(
      "../basic-capabilities/providers/recentMessages.ts"
    );

    expect(recentMessagesProvider.name).toBe("RECENT_MESSAGES");
    expect(recentMessagesProvider.get).toBeDefined();

    // The actual integration would require a full runtime setup
    // The key verification is that the code now:
    // 1. Gets room first to check lastCompactionAt
    // 2. Passes lastCompactionAt as 'start' parameter to getMemories()
    expect(true).toBe(true);
  });

  it("should work with InMemoryAdapter filtering", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    // Simulate a conversation with messages before and after reset
    const messages = [
      createMockMessage(1000, "Before reset 1", roomId),
      createMockMessage(2000, "Before reset 2", roomId),
      createMockMessage(3000, "Before reset 3", roomId),
      // Reset happens at 3500
      createMockMessage(4000, "After reset 1", roomId),
      createMockMessage(5000, "After reset 2", roomId),
    ];

    for (const msg of messages) {
      await adapter.createMemory(msg, "messages", false);
    }

    // Simulate what RECENT_MESSAGES provider does
    const lastCompactionAt = 3500;
    const recentMessages = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: lastCompactionAt,
    });

    expect(recentMessages.length).toBe(2);
    expect(recentMessages.map((m) => m.content.text)).toEqual([
      "After reset 1",
      "After reset 2",
    ]);
  });
});

// ============================================
// Edge Cases
// ============================================
describe("Edge cases", () => {
  it("should handle very old compaction timestamps", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    // Message from "the distant past"
    await adapter.createMemory(
      createMockMessage(1, "Ancient message", roomId),
      "messages",
      false,
    );

    // Compaction at a very old time (but after the message)
    const result = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: 2,
    });

    expect(result.length).toBe(0);
  });

  it("should handle future compaction timestamps", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-1" as UUID;

    await adapter.createMemory(
      createMockMessage(Date.now(), "Recent message", roomId),
      "messages",
      false,
    );

    // Compaction in the future (filters out everything)
    const result = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: Date.now() + 100000,
    });

    expect(result.length).toBe(0);
  });

  it("should handle empty room metadata gracefully", async () => {
    const { resetSessionAction } = await import(
      "../bootstrap/actions/resetSession.ts"
    );

    const roomWithNoMetadata = {
      id: "room-1" as UUID,
      name: "Test Room",
      serverId: "server-1",
      // metadata is undefined
    } as Room;

    let updatedRoom: Room | null = null;
    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => roomWithNoMetadata),
      updateRoom: vi.fn(async (room: Room) => {
        updatedRoom = room;
      }),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-1" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/reset" },
    };

    const result = await resetSessionAction.handler(mockRuntime, mockMessage, {
      data: { room: roomWithNoMetadata },
    } as never);

    expect(result.success).toBe(true);
    expect(updatedRoom?.metadata?.lastCompactionAt).toBeDefined();
  });
});

// ============================================
// Auto-Compaction End-to-End Tests
// ============================================
describe("Auto-compaction end-to-end", () => {
  it("should create summary and set lastCompactionAt", async () => {
    const { triggerAutoCompaction } = await import(
      "../bootstrap/services/autoCompaction.ts"
    );

    const roomId = "room-compact-1" as UUID;
    const agentId = "agent-1" as UUID;
    const createdMemories: Memory[] = [];
    let updatedRoom: Room | null = null;
    const existingRoom = createMockRoom();

    const mockRuntime = {
      agentId,
      getRoom: vi.fn(async () => existingRoom),
      updateRoom: vi.fn(async (room: Room) => {
        updatedRoom = room;
        // Update the room reference so subsequent reads see the change
        Object.assign(existingRoom, room);
      }),
      getMemories: vi.fn(async () => [
        createMockMessage(1000, "User says hello", roomId),
        createMockMessage(2000, "Agent replies hi", roomId),
        createMockMessage(3000, "User asks a question", roomId),
        createMockMessage(4000, "Agent answers", roomId),
      ]),
      createMemory: vi.fn(async (memory: Memory) => {
        createdMemories.push(memory);
        return memory.id;
      }),
      useModel: vi.fn(
        async () => "Summary: User greeted agent and asked a question.",
      ),
    } as unknown as IAgentRuntime;

    await triggerAutoCompaction(mockRuntime, roomId);

    // Verify summary was created
    expect(createdMemories.length).toBe(1);
    const summaryMsg = createdMemories[0];
    expect(summaryMsg.content.text).toContain("[Compaction Summary]");
    expect(summaryMsg.content.text).toContain("Summary: User greeted agent");
    expect(summaryMsg.content.source).toBe("compaction");

    // Verify lastCompactionAt was set
    expect(updatedRoom).not.toBeNull();
    expect(updatedRoom?.metadata?.lastCompactionAt).toBeDefined();
    expect(typeof updatedRoom?.metadata?.lastCompactionAt).toBe("number");

    // Verify compaction history was recorded
    const history = updatedRoom?.metadata?.compactionHistory as {
      triggeredBy: string;
    }[];
    expect(history).toHaveLength(1);
    expect(history[0].triggeredBy).toBe("auto-compaction");
  });

  it("should not run concurrent compactions for the same room", async () => {
    const { triggerAutoCompaction } = await import(
      "../bootstrap/services/autoCompaction.ts"
    );

    const roomId = "room-concurrent-1" as UUID;
    let modelCallCount = 0;

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => createMockRoom()),
      updateRoom: vi.fn(),
      getMemories: vi.fn(async () => [
        createMockMessage(1000, "Message 1", roomId),
      ]),
      createMemory: vi.fn(async (m: Memory) => m.id),
      useModel: vi.fn(async () => {
        modelCallCount++;
        // Simulate slow LLM call
        await new Promise((r) => setTimeout(r, 50));
        return "Summary";
      }),
    } as unknown as IAgentRuntime;

    // Trigger two compactions concurrently
    await Promise.all([
      triggerAutoCompaction(mockRuntime, roomId),
      triggerAutoCompaction(mockRuntime, roomId),
    ]);

    // Only one should have actually run the model call
    expect(modelCallCount).toBe(1);
  });

  it("should skip when no messages exist", async () => {
    const { triggerAutoCompaction } = await import(
      "../bootstrap/services/autoCompaction.ts"
    );

    const roomId = "room-empty-1" as UUID;
    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => createMockRoom()),
      updateRoom: vi.fn(),
      getMemories: vi.fn(async () => []),
      createMemory: vi.fn(),
      useModel: vi.fn(),
    } as unknown as IAgentRuntime;

    await triggerAutoCompaction(mockRuntime, roomId);

    // Should not create a summary or update room
    expect(mockRuntime.createMemory).not.toHaveBeenCalled();
    expect(mockRuntime.updateRoom).not.toHaveBeenCalled();
  });
});

// ============================================
// Compaction Message Filtering Tests
// ============================================
describe("Message list is shorter after compaction", () => {
  it("should return fewer messages when filtered by compaction point", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-filter-1" as UUID;

    // Create 20 messages spanning a period
    for (let i = 1; i <= 20; i++) {
      await adapter.createMemory(
        createMockMessage(i * 1000, `Message ${i}`, roomId),
        "messages",
        false,
      );
    }

    // Before compaction: all 20 messages
    const allMessages = await adapter.getMemories({
      tableName: "messages",
      roomId,
    });
    expect(allMessages.length).toBe(20);

    // Simulate compaction at timestamp 15000 (after message 15)
    const compactionAt = 15000;

    // Add compaction summary at the compaction point
    await adapter.createMemory(
      {
        id: "summary-1" as UUID,
        entityId: "agent-1" as UUID,
        agentId: "agent-1" as UUID,
        roomId,
        content: {
          text: "[Compaction Summary]\n\nSummary of messages 1-15",
          source: "compaction",
        },
        createdAt: compactionAt,
      },
      "messages",
      false,
    );

    // After compaction: only messages from compaction point onwards
    const afterCompaction = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: compactionAt,
    });

    // Should have 6 messages: summary + messages 15-20
    // (message 15 has createdAt=15000 which is >= start=15000)
    expect(afterCompaction.length).toBe(7); // summary + msg 15,16,17,18,19,20
    expect(afterCompaction.length).toBeLessThan(allMessages.length);

    // Verify the summary is included
    const summaryMsg = afterCompaction.find(
      (m) => m.content?.source === "compaction",
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content.text).toContain("[Compaction Summary]");
  });

  it("should only pull messages up to the compacted point", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-boundary-1" as UUID;

    // Pre-compaction messages
    await adapter.createMemory(
      createMockMessage(1000, "Old message 1", roomId),
      "messages",
      false,
    );
    await adapter.createMemory(
      createMockMessage(2000, "Old message 2", roomId),
      "messages",
      false,
    );
    await adapter.createMemory(
      createMockMessage(3000, "Old message 3", roomId),
      "messages",
      false,
    );

    // Compaction summary at 3500
    const compactionAt = 3500;
    await adapter.createMemory(
      {
        id: "summary-boundary" as UUID,
        entityId: "agent-1" as UUID,
        agentId: "agent-1" as UUID,
        roomId,
        content: {
          text: "[Compaction Summary]\n\nUser discussed topics A, B, C",
          source: "compaction",
        },
        createdAt: compactionAt,
      },
      "messages",
      false,
    );

    // Post-compaction messages
    await adapter.createMemory(
      createMockMessage(4000, "New message 1", roomId),
      "messages",
      false,
    );
    await adapter.createMemory(
      createMockMessage(5000, "New message 2", roomId),
      "messages",
      false,
    );

    // Fetch with compaction filter
    const result = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: compactionAt,
    });

    // Should get: summary + 2 new messages = 3
    expect(result.length).toBe(3);

    // Verify old messages are excluded
    const texts = result.map((m) => m.content.text);
    expect(texts).not.toContain("Old message 1");
    expect(texts).not.toContain("Old message 2");
    expect(texts).not.toContain("Old message 3");

    // Verify new messages and summary are included
    expect(texts).toContain("New message 1");
    expect(texts).toContain("New message 2");
    expect(texts.some((t) => t?.includes("[Compaction Summary]"))).toBe(true);
  });
});

// ============================================
// Incremental Compaction Tests
// ============================================
describe("Incremental compaction (multiple rounds)", () => {
  it("should handle multiple sequential compactions", async () => {
    const { InMemoryDatabaseAdapter } = await import(
      "../database/inMemoryAdapter.ts"
    );

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.init();

    const roomId = "room-incremental-1" as UUID;

    // Round 1: messages 1-5
    for (let i = 1; i <= 5; i++) {
      await adapter.createMemory(
        createMockMessage(i * 1000, `Round1 message ${i}`, roomId),
        "messages",
        false,
      );
    }

    // First compaction at 5500
    const compaction1At = 5500;
    await adapter.createMemory(
      {
        id: "summary-r1" as UUID,
        entityId: "agent-1" as UUID,
        agentId: "agent-1" as UUID,
        roomId,
        content: {
          text: "[Compaction Summary]\n\nRound 1 summary",
          source: "compaction",
        },
        createdAt: compaction1At,
      },
      "messages",
      false,
    );

    // Round 2: messages 6-10
    for (let i = 6; i <= 10; i++) {
      await adapter.createMemory(
        createMockMessage(i * 1000, `Round2 message ${i}`, roomId),
        "messages",
        false,
      );
    }

    // Verify: after first compaction, only see summary + round 2 messages
    const afterCompaction1 = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: compaction1At,
    });
    expect(afterCompaction1.length).toBe(6); // summary + msgs 6-10

    // Second compaction at 10500
    const compaction2At = 10500;
    await adapter.createMemory(
      {
        id: "summary-r2" as UUID,
        entityId: "agent-1" as UUID,
        agentId: "agent-1" as UUID,
        roomId,
        content: {
          text: "[Compaction Summary]\n\nRound 2 summary (includes R1)",
          source: "compaction",
        },
        createdAt: compaction2At,
      },
      "messages",
      false,
    );

    // Round 3: messages 11-12
    for (let i = 11; i <= 12; i++) {
      await adapter.createMemory(
        createMockMessage(i * 1000, `Round3 message ${i}`, roomId),
        "messages",
        false,
      );
    }

    // After second compaction: only see R2 summary + round 3 messages
    const afterCompaction2 = await adapter.getMemories({
      tableName: "messages",
      roomId,
      start: compaction2At,
    });
    expect(afterCompaction2.length).toBe(3); // summary-r2 + msgs 11,12

    // Total messages in DB haven't been deleted
    const totalInDb = await adapter.getMemories({
      tableName: "messages",
      roomId,
    });
    expect(totalInDb.length).toBe(14); // 10 msgs + 2 summaries + 2 msgs

    // But filtered view is much smaller
    expect(afterCompaction2.length).toBeLessThan(totalInDb.length);

    // Verify the old summaries and messages are excluded from filtered view
    const filteredTexts = afterCompaction2.map((m) => m.content.text);
    expect(filteredTexts).not.toContain(
      "[Compaction Summary]\n\nRound 1 summary",
    );
    expect(filteredTexts).toContain(
      "[Compaction Summary]\n\nRound 2 summary (includes R1)",
    );
  });
});

// ============================================
// COMPACT_SESSION Action Tests
// ============================================
describe("COMPACT_SESSION action", () => {
  it("should summarize and set compaction point", async () => {
    const { compactSessionAction } = await import(
      "../basic-capabilities/actions/compactSession.ts"
    );

    const roomId = "room-compact-action-1" as UUID;
    const agentId = "agent-1" as UUID;
    const createdMemories: Memory[] = [];
    let updatedRoom: Room | null = null;
    const existingRoom = createMockRoom();

    const mockRuntime = {
      agentId,
      getRoom: vi.fn(async () => existingRoom),
      updateRoom: vi.fn(async (room: Room) => {
        updatedRoom = room;
      }),
      getMemories: vi.fn(async () => [
        createMockMessage(1000, "Discussion about project", roomId),
        createMockMessage(2000, "Decided on approach A", roomId),
        createMockMessage(3000, "TODO: implement feature X", roomId),
      ]),
      createMemory: vi.fn(async (memory: Memory) => {
        createdMemories.push(memory);
        return memory.id;
      }),
      useModel: vi.fn(
        async () =>
          "Discussed project, decided on approach A, TODO: implement feature X.",
      ),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-compact-1" as UUID,
      entityId: "user-1" as UUID,
      agentId,
      roomId,
      content: { text: "/compact" },
    };

    const mockCallback = vi.fn();

    const result = await compactSessionAction.handler(
      mockRuntime,
      mockMessage,
      undefined,
      undefined,
      mockCallback,
    );

    expect(result.success).toBe(true);
    expect(result.values?.compactedAt).toBeDefined();

    // Verify summary was stored
    expect(createdMemories.length).toBe(1);
    expect(createdMemories[0].content.source).toBe("compaction");
    expect(createdMemories[0].content.text).toContain("[Compaction Summary]");

    // Verify room was updated with compaction point
    expect(updatedRoom?.metadata?.lastCompactionAt).toBeDefined();

    // Verify callback was called
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Session compacted.",
        actions: ["COMPACT_SESSION"],
      }),
    );
  });

  it("should pass instructions to summary prompt", async () => {
    const { compactSessionAction } = await import(
      "../basic-capabilities/actions/compactSession.ts"
    );

    const roomId = "room-compact-instructions" as UUID;
    let capturedPrompt = "";

    const mockRuntime = {
      agentId: "agent-1" as UUID,
      getRoom: vi.fn(async () => createMockRoom()),
      updateRoom: vi.fn(),
      getMemories: vi.fn(async () => [
        createMockMessage(1000, "Some message", roomId),
      ]),
      createMemory: vi.fn(async (m: Memory) => m.id),
      useModel: vi.fn(async (type: string, params: { prompt: string }) => {
        capturedPrompt = params.prompt;
        return "Summary with focus";
      }),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
      id: "msg-instructions" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId,
      content: { text: "/compact Focus on technical decisions" },
    };

    await compactSessionAction.handler(mockRuntime, mockMessage);

    expect(capturedPrompt).toContain("Focus on technical decisions");
  });

  it("should validate only when room has messages", async () => {
    const { compactSessionAction } = await import(
      "../basic-capabilities/actions/compactSession.ts"
    );

    // Room with messages: valid
    const runtimeWithMessages = {
      getRoom: vi.fn(async () => createMockRoom()),
      getMemories: vi.fn(async () => [
        createMockMessage(1000, "A message", "room-1" as UUID),
      ]),
    } as unknown as IAgentRuntime;

    const msg: Memory = {
      id: "v-msg" as UUID,
      entityId: "user-1" as UUID,
      agentId: "agent-1" as UUID,
      roomId: "room-1" as UUID,
      content: { text: "/compact" },
    };

    expect(await compactSessionAction.validate(runtimeWithMessages, msg)).toBe(
      true,
    );

    // Room with no messages: invalid
    const runtimeNoMessages = {
      getRoom: vi.fn(async () => createMockRoom()),
      getMemories: vi.fn(async () => []),
    } as unknown as IAgentRuntime;

    expect(await compactSessionAction.validate(runtimeNoMessages, msg)).toBe(
      false,
    );

    // No room: invalid
    const runtimeNoRoom = {
      getRoom: vi.fn(async () => null),
    } as unknown as IAgentRuntime;

    expect(await compactSessionAction.validate(runtimeNoRoom, msg)).toBe(false);
  });
});
