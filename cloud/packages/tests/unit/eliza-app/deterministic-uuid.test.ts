/**
 * Deterministic UUID Generation Tests
 *
 * Tests UUID generation for room and entity IDs:
 * - Deterministic output (same input = same output)
 * - Valid UUID format
 * - Different inputs produce different outputs
 * - Edge cases and boundary conditions
 */

import { describe, expect, test } from "bun:test";
import {
  generateDeterministicUUID,
  generateElizaAppEntityId,
  generateElizaAppRoomId,
} from "@/lib/utils/deterministic-uuid";

describe("generateDeterministicUUID", () => {
  test("produces valid UUID format", () => {
    const uuid = generateDeterministicUUID("test-input");
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(uuid).toMatch(uuidRegex);
  });

  test("is deterministic - same input produces same output", () => {
    const input = "eliza-app:telegram:user:123456789";
    const uuid1 = generateDeterministicUUID(input);
    const uuid2 = generateDeterministicUUID(input);
    expect(uuid1).toBe(uuid2);
  });

  test("different inputs produce different outputs", () => {
    const uuid1 = generateDeterministicUUID("input-a");
    const uuid2 = generateDeterministicUUID("input-b");
    expect(uuid1).not.toBe(uuid2);
  });

  test("handles empty string input", () => {
    const uuid = generateDeterministicUUID("");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("handles unicode input", () => {
    const uuid = generateDeterministicUUID("用户测试🎉");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("handles very long input", () => {
    const longInput = "x".repeat(10000);
    const uuid = generateDeterministicUUID(longInput);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("handles special characters", () => {
    const uuid = generateDeterministicUUID("user@email.com+test/path?query=1&foo=bar");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("output is always lowercase", () => {
    const uuid = generateDeterministicUUID("TEST-INPUT");
    expect(uuid).toBe(uuid.toLowerCase());
  });
});

describe("generateElizaAppRoomId", () => {
  const agentId = "b850bc30-45f8-0041-a00a-83df46d8555d";

  test("generates valid UUID for Telegram room", () => {
    const roomId = generateElizaAppRoomId("telegram", agentId, "123456789");
    expect(roomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates valid UUID for iMessage room", () => {
    const roomId = generateElizaAppRoomId("imessage", agentId, "+14155551234");
    expect(roomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("same agent + user = same room ID", () => {
    const roomId1 = generateElizaAppRoomId("telegram", agentId, "123456789");
    const roomId2 = generateElizaAppRoomId("telegram", agentId, "123456789");
    expect(roomId1).toBe(roomId2);
  });

  test("different users = different room IDs", () => {
    const roomId1 = generateElizaAppRoomId("telegram", agentId, "111111111");
    const roomId2 = generateElizaAppRoomId("telegram", agentId, "222222222");
    expect(roomId1).not.toBe(roomId2);
  });

  test("different agents = different room IDs for same user", () => {
    const roomId1 = generateElizaAppRoomId("telegram", "agent-a", "123456789");
    const roomId2 = generateElizaAppRoomId("telegram", "agent-b", "123456789");
    expect(roomId1).not.toBe(roomId2);
  });

  test("different channels = different room IDs for same identifier", () => {
    const telegramRoom = generateElizaAppRoomId("telegram", agentId, "123456789");
    const imessageRoom = generateElizaAppRoomId("imessage", agentId, "123456789");
    expect(telegramRoom).not.toBe(imessageRoom);
  });
});

describe("generateElizaAppEntityId", () => {
  test("generates valid UUID for Telegram user", () => {
    const entityId = generateElizaAppEntityId("telegram", "123456789");
    expect(entityId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates valid UUID for iMessage user", () => {
    const entityId = generateElizaAppEntityId("imessage", "+14155551234");
    expect(entityId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("same identifier = same entity ID", () => {
    const entityId1 = generateElizaAppEntityId("telegram", "123456789");
    const entityId2 = generateElizaAppEntityId("telegram", "123456789");
    expect(entityId1).toBe(entityId2);
  });

  test("different identifiers = different entity IDs", () => {
    const entityId1 = generateElizaAppEntityId("telegram", "111111111");
    const entityId2 = generateElizaAppEntityId("telegram", "222222222");
    expect(entityId1).not.toBe(entityId2);
  });

  test("different channels = different entity IDs for same identifier", () => {
    const telegramEntity = generateElizaAppEntityId("telegram", "123456789");
    const imessageEntity = generateElizaAppEntityId("imessage", "123456789");
    expect(telegramEntity).not.toBe(imessageEntity);
  });
});

describe("Cross-function consistency", () => {
  test("room ID and entity ID are different for same user", () => {
    const agentId = "test-agent";
    const userId = "123456789";
    const roomId = generateElizaAppRoomId("telegram", agentId, userId);
    const entityId = generateElizaAppEntityId("telegram", userId);
    expect(roomId).not.toBe(entityId);
  });
});
