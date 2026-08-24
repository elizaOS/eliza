/**
 * Pins the shared-runtime room-label normalization precedence shared by the
 * Durable Object and runtime storage identities.
 */
import { describe, expect, test } from "bun:test";
import { normalizeSharedRuntimeRoom } from "./shared-runtime-room-identity";

describe("normalizeSharedRuntimeRoom", () => {
  test("prefers roomId over userId", () => {
    expect(normalizeSharedRuntimeRoom("room-1", "user-1")).toBe("room-1");
  });

  test("falls back to userId when roomId is absent", () => {
    expect(normalizeSharedRuntimeRoom(undefined, "user-1")).toBe("user-1");
    expect(normalizeSharedRuntimeRoom(null, "user-1")).toBe("user-1");
  });

  test("uses roomId alone when userId is absent", () => {
    expect(normalizeSharedRuntimeRoom("room-1")).toBe("room-1");
  });

  test("falls back to the default label when both are absent", () => {
    expect(normalizeSharedRuntimeRoom()).toBe("default");
    expect(normalizeSharedRuntimeRoom(undefined, undefined)).toBe("default");
    expect(normalizeSharedRuntimeRoom(null, null)).toBe("default");
  });

  test("treats empty or whitespace roomId as absent", () => {
    expect(normalizeSharedRuntimeRoom("", "user-1")).toBe("user-1");
    expect(normalizeSharedRuntimeRoom("   ", "user-1")).toBe("user-1");
  });

  test("treats non-string roomId as absent", () => {
    expect(normalizeSharedRuntimeRoom(42, "user-1")).toBe("user-1");
    expect(normalizeSharedRuntimeRoom({}, "user-1")).toBe("user-1");
    expect(normalizeSharedRuntimeRoom(["room-1"], "user-1")).toBe("user-1");
  });

  test("treats non-string or blank userId as absent", () => {
    expect(normalizeSharedRuntimeRoom(undefined, 42)).toBe("default");
    expect(normalizeSharedRuntimeRoom(undefined, "")).toBe("default");
    expect(normalizeSharedRuntimeRoom(undefined, "  ")).toBe("default");
  });

  test("trims normalized labels", () => {
    expect(normalizeSharedRuntimeRoom("  room-1  ")).toBe("room-1");
    expect(normalizeSharedRuntimeRoom(undefined, "  user-1  ")).toBe("user-1");
  });
});
