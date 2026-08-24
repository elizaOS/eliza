/** Exercises session-identity generation, UUID validation, and room-id derivation against the real core helpers. */
import { describe, expect, it } from "bun:test";
import { stringToUuid } from "@elizaos/core";
import {
  createRoomElizaId,
  ensureSessionIdentity,
  getMainRoomElizaId,
  isUuidString,
} from "./identity.js";

const V4_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const V4_B = "9b2f1c6e-8a47-4e5a-b1c3-7d90e2f4a6b8";
const V4_C = "c1a7e5f3-2b48-49d6-8e0a-5f3b7c9d1e2a";

describe("isUuidString", () => {
  it("accepts a canonical lowercase v4 UUID", () => {
    expect(isUuidString(V4_A)).toBe(true);
  });

  it("accepts uppercase hex (case-insensitive)", () => {
    expect(isUuidString(V4_A.toUpperCase())).toBe(true);
  });

  it("accepts non-v4 versions within [1-5]", () => {
    expect(isUuidString("12345678-1234-1678-9234-123456789abc")).toBe(true);
    expect(isUuidString("12345678-1234-5678-9234-123456789abc")).toBe(true);
  });

  it("rejects version digits outside [1-5]", () => {
    expect(isUuidString("12345678-1234-0678-9234-123456789abc")).toBe(false);
    expect(isUuidString("12345678-1234-7678-9234-123456789abc")).toBe(false);
  });

  it("rejects an invalid variant nibble", () => {
    expect(isUuidString("12345678-1234-4678-c234-123456789abc")).toBe(false);
  });

  it("rejects malformed and empty input", () => {
    expect(isUuidString("not-a-uuid")).toBe(false);
    expect(isUuidString("3f2504e04f8941d39a0c0305e82c3301")).toBe(false);
    expect(isUuidString("")).toBe(false);
  });
});

describe("ensureSessionIdentity", () => {
  it("echoes a fully valid identity back unchanged", () => {
    const input = {
      projectId: V4_A,
      userId: V4_B,
      worldId: V4_C,
      messageServerId: "d2b8f6a4-3c59-4a71-9b0e-6d4f8a2c5e7b",
    };

    expect(ensureSessionIdentity(input)).toEqual(input);
  });

  it("generates a fresh random projectId and userId when absent", () => {
    const first = ensureSessionIdentity();
    const second = ensureSessionIdentity();

    expect(isUuidString(first.projectId)).toBe(true);
    expect(isUuidString(first.userId)).toBe(true);
    expect(first.projectId).not.toBe(second.projectId);
    expect(first.userId).not.toBe(second.userId);
  });

  it("derives world and message-server ids from the generated projectId", () => {
    const identity = ensureSessionIdentity();

    expect(identity.worldId).toBe(
      stringToUuid(`eliza-code:world:${identity.projectId}`),
    );
    expect(identity.messageServerId).toBe(
      stringToUuid(`eliza-code:server:${identity.projectId}`),
    );
  });

  it("derives world and message-server ids from a supplied projectId", () => {
    const identity = ensureSessionIdentity({
      projectId: V4_A,
      userId: V4_B,
    });

    expect(identity.projectId).toBe(V4_A);
    expect(identity.userId).toBe(V4_B);
    expect(identity.worldId).toBe(stringToUuid(`eliza-code:world:${V4_A}`));
    expect(identity.messageServerId).toBe(
      stringToUuid(`eliza-code:server:${V4_A}`),
    );
  });

  it("replaces invalid projectId/userId but keeps valid world/messageServer ids", () => {
    const identity = ensureSessionIdentity({
      projectId: "not-a-uuid",
      userId: "",
      worldId: V4_C,
      messageServerId: "d2b8f6a4-3c59-4a71-9b0e-6d4f8a2c5e7b",
    });

    expect(identity.projectId).not.toBe("not-a-uuid");
    expect(isUuidString(identity.projectId)).toBe(true);
    expect(identity.userId).not.toBe("");
    expect(isUuidString(identity.userId)).toBe(true);
    expect(identity.worldId).toBe(V4_C);
    expect(identity.messageServerId).toBe(
      "d2b8f6a4-3c59-4a71-9b0e-6d4f8a2c5e7b",
    );
  });

  it("regenerates derived fields when they are themselves invalid", () => {
    const identity = ensureSessionIdentity({ projectId: V4_A, worldId: "" });

    expect(identity.projectId).toBe(V4_A);
    expect(identity.worldId).toBe(
      stringToUuid(`eliza-code:world:${identity.projectId}`),
    );
    expect(identity.worldId).not.toBe("");
  });
});

describe("room id derivation", () => {
  it("returns one stable main-room id per project", () => {
    const identity = ensureSessionIdentity({ projectId: V4_A });
    const first = getMainRoomElizaId(identity);
    const second = getMainRoomElizaId(identity);

    expect(first).toBe(second);
    expect(first).toBe(stringToUuid(`eliza-code:room:${V4_A}:main`));
  });

  it("gives different projects different main-room ids", () => {
    const a = getMainRoomElizaId(ensureSessionIdentity({ projectId: V4_A }));
    const b = getMainRoomElizaId(ensureSessionIdentity({ projectId: V4_B }));

    expect(a).not.toBe(b);
  });

  it("creates a unique room id on every call", () => {
    const identity = ensureSessionIdentity({ projectId: V4_A });
    const main = getMainRoomElizaId(identity);
    const a = createRoomElizaId(identity);
    const b = createRoomElizaId(identity);

    expect(a).not.toBe(b);
    expect(a).not.toBe(main);
    expect(b).not.toBe(main);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(b).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("derives core-format ids that this module's own [1-5] validator rejects", () => {
    // stringToUuid stamps a custom version nibble of 0, so derived world,
    // server, and room ids are NOT accepted by isUuidString even though
    // random projectId/userId values are.
    const identity = ensureSessionIdentity({ projectId: V4_A, userId: V4_B });

    expect(isUuidString(identity.worldId)).toBe(false);
    expect(isUuidString(identity.messageServerId)).toBe(false);
    expect(isUuidString(getMainRoomElizaId(identity))).toBe(false);
    expect(isUuidString(createRoomElizaId(identity))).toBe(false);
  });

  it("round-trips a persisted identity to the same derived ids", () => {
    const original = ensureSessionIdentity({
      projectId: V4_A,
      userId: V4_B,
    });
    const reloaded = ensureSessionIdentity({
      projectId: original.projectId,
      userId: original.userId,
      worldId: original.worldId,
      messageServerId: original.messageServerId,
    });

    expect(reloaded).toEqual(original);
  });
});
