import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureSessionIdentity } from "../lib/identity.js";
import {
  clearSession,
  deserializeRoom,
  isValidSessionData,
  loadSession,
  type SerializedRoom,
  type SessionState,
  sanitizeRole,
  saveSession,
  serializeRoom,
  toDate,
  toEpoch,
} from "../lib/session.js";
import type { ChatRoom, Message } from "../types.js";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_SESSION_DIR = ".eliza-code-test";

function createTestMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    role: "user",
    content: "Hello, world!",
    timestamp: new Date("2024-01-15T10:30:00Z"),
    roomId: "room-1",
    ...overrides,
  };
}

function createTestRoom(overrides: Partial<ChatRoom> = {}): ChatRoom {
  return {
    id: "room-1",
    name: "Test Room",
    messages: [createTestMessage()],
    createdAt: new Date("2024-01-15T10:00:00Z"),
    taskIds: ["task-1"],
    elizaRoomId: "eliza-room-1" as UUID,
    ...overrides,
  };
}

function createTestSession(
  overrides: Partial<SessionState> = {},
): SessionState {
  return {
    rooms: [createTestRoom()],
    currentRoomId: "room-1",
    currentTaskId: "task-1",
    cwd: "/test/path",
    identity: ensureSessionIdentity({
      projectId: "test-project" as UUID,
      userId: "test-user" as UUID,
      worldId: "test-world" as UUID,
      messageServerId: "test-server" as UUID,
    }),
    focusedPane: "tasks",
    taskPaneVisibility: "shown",
    taskPaneWidthFraction: 0.55,
    showFinishedTasks: true,
    ...overrides,
  };
}

// ============================================================================
// Helper Functions Tests
// ============================================================================

describe("toEpoch", () => {
  test("should convert Date to epoch", () => {
    const date = new Date("2024-01-15T10:30:00Z");
    expect(toEpoch(date)).toBe(date.getTime());
  });

  test("should return number as-is", () => {
    const epoch = 1705315800000;
    expect(toEpoch(epoch)).toBe(epoch);
  });

  test("should parse ISO string", () => {
    const isoString = "2024-01-15T10:30:00Z";
    expect(toEpoch(isoString)).toBe(new Date(isoString).getTime());
  });

  test("should return current time for undefined", () => {
    const before = Date.now();
    const result = toEpoch(undefined);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  test("should return current time for invalid string", () => {
    const before = Date.now();
    const result = toEpoch("not a date");
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

describe("toDate", () => {
  test("should convert epoch to Date", () => {
    const epoch = 1705315800000;
    const result = toDate(epoch);
    expect(result.getTime()).toBe(epoch);
  });

  test("should return current date for undefined", () => {
    const before = Date.now();
    const result = toDate(undefined);
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  test("should return current date for NaN", () => {
    const before = Date.now();
    const result = toDate(NaN);
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("sanitizeRole", () => {
  test("should return valid roles unchanged", () => {
    expect(sanitizeRole("user")).toBe("user");
    expect(sanitizeRole("assistant")).toBe("assistant");
    expect(sanitizeRole("system")).toBe("system");
  });

  test("should return system for invalid roles", () => {
    expect(sanitizeRole("invalid")).toBe("system");
    expect(sanitizeRole("")).toBe("system");
    expect(sanitizeRole("admin")).toBe("system");
  });
});

// ============================================================================
// Serialization Tests
// ============================================================================

describe("serializeRoom", () => {
  test("should serialize room with messages", () => {
    const room = createTestRoom();
    const result = serializeRoom(room);

    expect(result.id).toBe("room-1");
    expect(result.name).toBe("Test Room");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-1");
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello, world!");
    expect(typeof result.messages[0].timestamp).toBe("number");
    expect(typeof result.createdAt).toBe("number");
    expect(result.taskIds).toEqual(["task-1"]);
  });

  test("should handle empty messages array", () => {
    const room = createTestRoom({ messages: [] });
    const result = serializeRoom(room);
    expect(result.messages).toEqual([]);
  });

  test("should handle missing fields with defaults", () => {
    const partialRoom = {
      id: "",
      name: "",
      messages: [],
      createdAt: new Date(),
      taskIds: [],
      elizaRoomId: "test" as UUID,
    } as ChatRoom;

    const result = serializeRoom(partialRoom);
    expect(result.id).toBeTruthy(); // Should generate UUID
    expect(result.name).toBe("Chat");
  });
});

describe("deserializeRoom", () => {
  test("should deserialize room with messages", () => {
    const serialized: SerializedRoom = {
      id: "room-1",
      name: "Test Room",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello!",
          timestamp: 1705315800000,
          roomId: "room-1",
        },
      ],
      createdAt: 1705315800000,
      taskIds: ["task-1"],
      elizaRoomId: "eliza-1",
    };

    const result = deserializeRoom(serialized);

    expect(result.id).toBe("room-1");
    expect(result.name).toBe("Test Room");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-1");
    expect(result.messages[0].timestamp instanceof Date).toBe(true);
    expect(result.createdAt instanceof Date).toBe(true);
  });

  test("should handle missing optional fields", () => {
    const serialized: SerializedRoom = {
      id: "room-1",
      name: "Test",
      messages: [],
      createdAt: 1705315800000,
      taskIds: [],
      elizaRoomId: "eliza-1",
    };

    const result = deserializeRoom(serialized);
    expect(result.messages).toEqual([]);
    expect(result.taskIds).toEqual([]);
  });
});

// ============================================================================
// Validation Tests
// ============================================================================

describe("isValidSessionData", () => {
  test("should return true for valid session data", () => {
    const data = {
      version: 1,
      savedAt: Date.now(),
      currentRoomId: "room-1",
      currentTaskId: null,
      rooms: [],
      cwd: "/test",
    };
    expect(isValidSessionData(data)).toBe(true);
  });

  test("should return false for wrong version", () => {
    const data = {
      version: 2,
      currentRoomId: "room-1",
      rooms: [],
    };
    expect(isValidSessionData(data)).toBe(false);
  });

  test("should return false for missing currentRoomId", () => {
    const data = {
      version: 1,
      rooms: [],
    };
    expect(isValidSessionData(data)).toBe(false);
  });

  test("should return false for non-array rooms", () => {
    const data = {
      version: 1,
      currentRoomId: "room-1",
      rooms: "not an array",
    };
    expect(isValidSessionData(data)).toBe(false);
  });

  test("should return false for null", () => {
    expect(isValidSessionData(null)).toBe(false);
  });

  test("should return false for undefined", () => {
    expect(isValidSessionData(undefined)).toBe(false);
  });
});

// ============================================================================
// Round-trip Tests
// ============================================================================

describe("session round-trip", () => {
  test("should preserve data through serialize/deserialize cycle", () => {
    const original = createTestRoom();
    const serialized = serializeRoom(original);
    const deserialized = deserializeRoom(serialized);

    expect(deserialized.id).toBe(original.id);
    expect(deserialized.name).toBe(original.name);
    expect(deserialized.messages).toHaveLength(original.messages.length);
    expect(deserialized.messages[0].content).toBe(original.messages[0].content);
    expect(deserialized.messages[0].role).toBe(original.messages[0].role);
    expect(deserialized.taskIds).toEqual(original.taskIds);
  });

  test("should handle multiple messages", () => {
    const room = createTestRoom({
      messages: [
        createTestMessage({ id: "1", role: "user", content: "Hello" }),
        createTestMessage({ id: "2", role: "assistant", content: "Hi there!" }),
        createTestMessage({
          id: "3",
          role: "system",
          content: "System message",
        }),
      ],
    });

    const serialized = serializeRoom(room);
    const deserialized = deserializeRoom(serialized);

    expect(deserialized.messages).toHaveLength(3);
    expect(deserialized.messages[0].role).toBe("user");
    expect(deserialized.messages[1].role).toBe("assistant");
    expect(deserialized.messages[2].role).toBe("system");
  });
});

// ============================================================================
// File I/O Tests (Integration)
// ============================================================================

describe("saveSession and loadSession", () => {
  const originalCwd = process.cwd();
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = path.join(originalCwd, TEST_SESSION_DIR);
    await fs.mkdir(testDir, { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    // Restore original directory and clean up
    process.chdir(originalCwd);
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("should save and load session", async () => {
    const session = createTestSession();

    await saveSession(session);
    const loaded = await loadSession();

    expect(loaded).not.toBeNull();
    expect(loaded?.currentRoomId).toBe(session.currentRoomId);
    expect(loaded?.currentTaskId).toBe(session.currentTaskId);
    expect(loaded?.rooms).toHaveLength(1);
    expect(loaded?.rooms[0].name).toBe("Test Room");
    expect(loaded?.focusedPane).toBe("tasks");
    expect(loaded?.taskPaneVisibility).toBe("shown");
    expect(loaded?.taskPaneWidthFraction).toBe(0.55);
    expect(loaded?.showFinishedTasks).toBe(true);
  });

  test("should return null for missing session file", async () => {
    const loaded = await loadSession();
    expect(loaded).toBeNull();
  });

  test("should clear session file", async () => {
    const session = createTestSession();
    await saveSession(session);

    // Verify file exists
    const beforeLoad = await loadSession();
    expect(beforeLoad).not.toBeNull();

    // Clear and verify
    await clearSession();
    const afterLoad = await loadSession();
    expect(afterLoad).toBeNull();
  });

  test("should handle corrupted session file", async () => {
    // Write invalid JSON
    const sessionPath = path.join(testDir, ".eliza-code", "session.json");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, "{ invalid json }", "utf-8");

    const loaded = await loadSession();
    expect(loaded).toBeNull();
  });

  test("should handle session with wrong version", async () => {
    const sessionPath = path.join(testDir, ".eliza-code", "session.json");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        version: 999,
        currentRoomId: "room-1",
        rooms: [],
      }),
      "utf-8",
    );

    const loaded = await loadSession();
    expect(loaded).toBeNull();
  });

  test("should fallback to first room if currentRoomId not found", async () => {
    const session = createTestSession({
      currentRoomId: "non-existent-room",
    });

    await saveSession(session);
    const loaded = await loadSession();

    expect(loaded).not.toBeNull();
    // Should fall back to first room's ID
    expect(loaded?.currentRoomId).toBe("room-1");
  });
});
