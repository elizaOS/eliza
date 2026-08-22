/** Verifies exact and fail-closed task due-time conversion at the SQL persistence boundary. */

import type { TaskMetadata } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { readTaskDueAt, serializeTaskDueAt, taskMetadataForWrite } from "./task-timing";

describe("SQL task timing", () => {
  it("serializes safe bigint milliseconds as canonical ISO-8601", () => {
    expect(serializeTaskDueAt(1_900_000_005_000n)).toBe("2030-03-17T17:46:45.000Z");
    expect(readTaskDueAt({ scheduledAt: "2030-03-17T17:46:45.000Z" })).toBe(1_900_000_005_000);
    expect(serializeTaskDueAt(-1)).toBe("1969-12-31T23:59:59.999Z");
    expect(readTaskDueAt({ scheduledAt: "1969-12-31T23:59:59.999Z" })).toBe(-1);
  });

  it("reads a finite legacy numeric metadata value", () => {
    const legacy = {
      scheduledAt: 1_900_000_005_000,
    } as unknown as TaskMetadata;
    expect(readTaskDueAt(legacy)).toBe(1_900_000_005_000);
  });

  it("distinguishes absent, set, and explicit-clear writes", () => {
    expect(taskMetadataForWrite({ owner: "a" }, undefined)).toEqual({ owner: "a" });
    expect(taskMetadataForWrite({ scheduledAt: "2030-03-17T17:46:45.000Z" }, null)).toEqual({});
    expect(taskMetadataForWrite({ scheduledAt: "not-a-date" }, 0)).toEqual({
      scheduledAt: "1970-01-01T00:00:00.000Z",
    });
    expect(() => taskMetadataForWrite({ scheduledAt: "March 17, 2030" }, undefined)).toThrow(
      "ISO-8601"
    );
  });

  it("rejects lossy, out-of-range, and malformed values", () => {
    expect(() => serializeTaskDueAt(Number.NaN)).toThrow("safe integer");
    expect(() => serializeTaskDueAt(1.5)).toThrow("safe integer");
    expect(() => serializeTaskDueAt(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("safe integer");
    expect(() => readTaskDueAt({ scheduledAt: "not-a-date" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "2030-03-17T17:46:45Z" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "2030-03-17 17:46:45.000Z" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "2030-03-17T09:46:45.000-08:00" })).toThrow(
      "ISO-8601"
    );
  });
});
