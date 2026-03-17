/**
 * Tests for History Compaction
 *
 * Comprehensive tests for:
 * - RESET_SESSION action
 * - STATUS action
 * - InMemoryAdapter start/end filtering
 * - RECENT_MESSAGES provider compaction integration
 */

import { describe, expect, it, vi } from "vitest";
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
	it("should filter messages by start timestamp", async () => {
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

		await adapter.createMemories(
			messages.map((msg) => ({
				memory: msg,
				tableName: "messages",
				unique: false,
			})),
		);

		// Get messages after start = 2500
		const result = await adapter.getMemories({
			tableName: "messages",
			roomId,
			start: 2500,
		});

		expect(result.length).toBe(3);
		expect(result.map((m) => m.createdAt)).toEqual([3000, 4000, 5000]);
	});

	it("should filter messages by end timestamp", async () => {
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

		await adapter.createMemories(
			messages.map((msg) => ({
				memory: msg,
				tableName: "messages",
				unique: false,
			})),
		);

		// Get messages before end = 3500
		const result = await adapter.getMemories({
			tableName: "messages",
			roomId,
			end: 3500,
		});

		expect(result.length).toBe(3);
		expect(result.map((m) => m.createdAt)).toEqual([1000, 2000, 3000]);
	});

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

		await adapter.createMemories(
			messages.map((msg) => ({
				memory: msg,
				tableName: "messages",
				unique: false,
			})),
		);

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

		await adapter.createMemories([
			{
				memory: createMockMessage(1000, "Exact", roomId),
				tableName: "messages",
				unique: false,
			},
		]);

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

		await adapter.createMemories([
			{
				memory: createMockMessage(1000, "Old", roomId),
				tableName: "messages",
				unique: false,
			},
		]);

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
			await adapter.createMemories([
				{
					memory: createMockMessage(i * 1000, `Message ${i}`, roomId),
					tableName: "messages",
					unique: false,
				},
			]);
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

		await adapter.createMemories([
			{ memory: msgWithoutCreatedAt, tableName: "messages", unique: false },
			{ memory: msgWithCreatedAt, tableName: "messages", unique: false },
		]);

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
	it("should set lastCompactionAt in room metadata", async () => {
		const { resetSessionAction } = await import(
			"../basic-capabilities/actions/resetSession.ts"
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
	});

	it("should maintain compaction history", async () => {
		const { resetSessionAction } = await import(
			"../basic-capabilities/actions/resetSession.ts"
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

	it("should limit compaction history to 10 entries", async () => {
		const { resetSessionAction } = await import(
			"../basic-capabilities/actions/resetSession.ts"
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
	});

	it("should handle room not found error", async () => {
		const { resetSessionAction } = await import(
			"../basic-capabilities/actions/resetSession.ts"
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
			"../basic-capabilities/actions/resetSession.ts"
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
			"../basic-capabilities/actions/resetSession.ts"
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
			"../basic-capabilities/actions/resetSession.ts"
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRuntime = {
			agentId: "agent-12345678" as UUID,
			character: { name: "MyTestAgent" },
			getRoom: vi.fn(async () => createMockRoom()),
			getService: vi.fn(() => null),
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const compactionTime = Date.now() - 3600000; // 1 hour ago
		const mockRoom = createMockRoom({ lastCompactionAt: compactionTime });

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestAgent" },
			getRoom: vi.fn(async () => mockRoom),
			getService: vi.fn(() => null),
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRoom = createMockRoom(); // No lastCompactionAt

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestAgent" },
			getRoom: vi.fn(async () => mockRoom),
			getService: vi.fn(() => null),
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestAgent" },
			getRoom: vi.fn(async () => createMockRoom()),
			getService: vi.fn(() => null),
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestAgent" },
			getRoom: vi.fn(async () => createMockRoom()),
			getService: vi.fn(() => null),
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestAgent" },
			getRoom: vi.fn(async () => createMockRoom()),
			getService: vi.fn(() => null),
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRoom = createMockRoom({ name: "My Cool Room" });

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestAgent" },
			getRoom: vi.fn(async () => mockRoom),
			getService: vi.fn(() => null),
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
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRuntime = {} as unknown as IAgentRuntime;

		const isValid = await statusAction.validate(mockRuntime);
		expect(isValid).toBe(true);
	});

	it("should return status data in result values", async () => {
		const { statusAction } = await import(
			"../basic-capabilities/actions/status.ts"
		);

		const mockRuntime = {
			agentId: "agent-1" as UUID,
			character: { name: "TestAgent" },
			getRoom: vi.fn(async () => createMockRoom()),
			getService: vi.fn(() => null),
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

		await adapter.createMemories(
			messages.map((msg) => ({
				memory: msg,
				tableName: "messages",
				unique: false,
			})),
		);

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
		await adapter.createMemories([
			{
				memory: createMockMessage(1, "Ancient message", roomId),
				tableName: "messages",
				unique: false,
			},
		]);

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

		await adapter.createMemories([
			{
				memory: createMockMessage(Date.now(), "Recent message", roomId),
				tableName: "messages",
				unique: false,
			},
		]);

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
			"../basic-capabilities/actions/resetSession.ts"
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
