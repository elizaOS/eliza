/**
 * Unit coverage for the ConversationMessage type guard. Pure function, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  type ConversationMessage,
  isConversationMessage,
} from "./client-types-chat";

const valid: ConversationMessage = {
  id: "m1",
  role: "assistant",
  text: "hello",
  timestamp: 1_700_000_000_000,
};

describe("isConversationMessage", () => {
  it("accepts a well-formed message", () => {
    expect(isConversationMessage(valid)).toBe(true);
    expect(isConversationMessage({ ...valid, role: "user" })).toBe(true);
    // Optional fields present is still valid.
    expect(
      isConversationMessage({ ...valid, source: "autonomy", text: "" }),
    ).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, "x", 42, [], true]) {
      expect(isConversationMessage(v)).toBe(false);
    }
  });

  it("rejects a missing or empty id", () => {
    expect(isConversationMessage({ ...valid, id: undefined })).toBe(false);
    expect(isConversationMessage({ ...valid, id: "" })).toBe(false);
    expect(isConversationMessage({ ...valid, id: 1 })).toBe(false);
  });

  it("rejects an unexpected role", () => {
    expect(isConversationMessage({ ...valid, role: "system" })).toBe(false);
    expect(isConversationMessage({ ...valid, role: undefined })).toBe(false);
  });

  it("rejects a missing/invalid text", () => {
    expect(isConversationMessage({ ...valid, text: undefined })).toBe(false);
    expect(isConversationMessage({ ...valid, text: 123 })).toBe(false);
  });

  it("rejects a missing/non-finite timestamp", () => {
    expect(isConversationMessage({ ...valid, timestamp: undefined })).toBe(
      false,
    );
    expect(isConversationMessage({ ...valid, timestamp: "now" })).toBe(false);
    expect(isConversationMessage({ ...valid, timestamp: Number.NaN })).toBe(
      false,
    );
  });
});
