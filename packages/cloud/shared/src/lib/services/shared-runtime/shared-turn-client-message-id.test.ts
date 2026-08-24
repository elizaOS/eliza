/**
 * Pins the Shared turn coordinator idempotency-key boundary.
 *
 * A valid key drives durable claim/replay identity; absent, oversized, or
 * non-string input must yield an explicit undefined rather than fabricating
 * a durable identity (error-policy:J3).
 */
import { describe, expect, test } from "bun:test";
import { sharedTurnClientMessageId } from "./shared-turn-client-message-id";

describe("sharedTurnClientMessageId", () => {
  test("returns undefined for absent or non-object bodies", () => {
    expect(sharedTurnClientMessageId(undefined)).toBeUndefined();
    expect(sharedTurnClientMessageId(null)).toBeUndefined();
    expect(sharedTurnClientMessageId("payload")).toBeUndefined();
    expect(sharedTurnClientMessageId(42)).toBeUndefined();
    expect(sharedTurnClientMessageId(["id"])).toBeUndefined();
  });

  test("returns undefined when clientMessageId is missing or non-string", () => {
    expect(sharedTurnClientMessageId({})).toBeUndefined();
    expect(sharedTurnClientMessageId({ clientMessageId: undefined })).toBeUndefined();
    expect(sharedTurnClientMessageId({ clientMessageId: null })).toBeUndefined();
    expect(sharedTurnClientMessageId({ clientMessageId: 123 })).toBeUndefined();
    expect(sharedTurnClientMessageId({ clientMessageId: ["abc"] })).toBeUndefined();
  });

  test("returns undefined for empty or whitespace-only keys", () => {
    expect(sharedTurnClientMessageId({ clientMessageId: "" })).toBeUndefined();
    expect(sharedTurnClientMessageId({ clientMessageId: "   " })).toBeUndefined();
  });

  test("returns undefined for keys longer than the 128-char bound", () => {
    const oversized = "a".repeat(129);
    expect(sharedTurnClientMessageId({ clientMessageId: oversized })).toBeUndefined();
  });

  test("accepts a key at the 128-char boundary", () => {
    const atBoundary = "a".repeat(128);
    expect(sharedTurnClientMessageId({ clientMessageId: atBoundary })).toBe(atBoundary);
  });

  test("trims surrounding whitespace before returning the key", () => {
    expect(sharedTurnClientMessageId({ clientMessageId: "  turn-42  " })).toBe("turn-42");
  });

  test("returns a plain valid key unchanged", () => {
    expect(sharedTurnClientMessageId({ clientMessageId: "turn-42" })).toBe("turn-42");
  });
});
