/**
 * Tests for config-readers — helpers for safely reading values from untyped config objects.
 */
import { describe, expect, it } from "vitest";
import { asRecord, readString } from "./config-readers.ts";

describe("config-readers", () => {
  describe("asRecord", () => {
    it("re-exports asRecord from shared", async () => {
      const { asRecord: sharedAsRecord } = await import("@elizaos/shared");
      expect(asRecord).toBe(sharedAsRecord);
    });
  });

  describe("readString", () => {
    it("returns string for non-empty string values", () => {
      expect(readString({ key: "hello" }, "key")).toBe("hello");
      expect(readString({ key: "  world  " }, "key")).toBe("world");
    });

    it("returns null for missing key", () => {
      expect(readString({}, "missing")).toBeNull();
      expect(readString({ other: "val" }, "key")).toBeNull();
    });

    it("returns null for null or undefined source", () => {
      expect(readString(null, "key")).toBeNull();
      expect(readString(undefined, "key")).toBeNull();
    });

    it("returns null for empty or whitespace strings", () => {
      expect(readString({ key: "" }, "key")).toBeNull();
      expect(readString({ key: "   " }, "key")).toBeNull();
      expect(readString({ key: "\t\n" }, "key")).toBeNull();
    });

    it("returns null for non-string values", () => {
      expect(
        readString({ key: 123 } as unknown as Record<string, unknown>, "key"),
      ).toBeNull();
      expect(
        readString({ key: null } as unknown as Record<string, unknown>, "key"),
      ).toBeNull();
      expect(
        readString({ key: {} } as unknown as Record<string, unknown>, "key"),
      ).toBeNull();
      expect(
        readString({ key: [] } as unknown as Record<string, unknown>, "key"),
      ).toBeNull();
    });

    it("trims whitespace via asNonEmptyString", () => {
      expect(readString({ key: "  trimmed  " }, "key")).toBe("trimmed");
    });
  });
});
