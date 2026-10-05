/** Verifies exact and fail-closed task due-time conversion and canonicalisation at the SQL persistence boundary. */

import type { TaskMetadata } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  canonicalizeTaskScheduledAt,
  readTaskDueAt,
  serializeTaskDueAt,
  taskMetadataForWrite,
  taskMetadataPatchForWrite,
} from "./task-timing";

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

  it("canonicalises unambiguous ISO-8601 date-times on write and reads them back", () => {
    expect(canonicalizeTaskScheduledAt("2030-03-17T17:46:45Z")).toBe("2030-03-17T17:46:45.000Z");
    expect(canonicalizeTaskScheduledAt("2030-03-17T17:46Z")).toBe("2030-03-17T17:46:00.000Z");
    expect(canonicalizeTaskScheduledAt("2030-03-17T09:46:45.5-08:00")).toBe(
      "2030-03-17T17:46:45.500Z"
    );
    expect(canonicalizeTaskScheduledAt(1_900_000_005_000)).toBe("2030-03-17T17:46:45.000Z");
    expect(taskMetadataForWrite({ scheduledAt: "2030-03-17T17:46:45Z" }, undefined)).toEqual({
      scheduledAt: "2030-03-17T17:46:45.000Z",
    });
    expect(
      taskMetadataPatchForWrite({
        set: { paused: true, scheduledAt: "2030-03-17T17:46:45+00:00" },
        unset: ["lastError"],
      })
    ).toEqual({
      set: { paused: true, scheduledAt: "2030-03-17T17:46:45.000Z" },
      unset: ["lastError"],
    });
    expect(taskMetadataPatchForWrite({ set: { paused: true } })).toEqual({
      set: { paused: true },
    });
    expect(readTaskDueAt({ scheduledAt: "2030-03-17T17:46:45Z" })).toBe(1_900_000_005_000);
    expect(readTaskDueAt({ scheduledAt: "2030-03-17T09:46:45.000-08:00" })).toBe(1_900_000_005_000);
  });

  it("keeps years 0000 through 0099 as written instead of remapping them to the 1900s", () => {
    expect(canonicalizeTaskScheduledAt("0000-01-01T00:00:00Z")).toBe("0000-01-01T00:00:00.000Z");
    expect(readTaskDueAt({ scheduledAt: "0000-01-01T00:00:00.000Z" })).toBe(
      Date.parse("0000-01-01T00:00:00.000Z")
    );
    expect(canonicalizeTaskScheduledAt("0099-12-31T23:59:59.999Z")).toBe(
      "0099-12-31T23:59:59.999Z"
    );
    expect(canonicalizeTaskScheduledAt("0096-02-29T12:00:00+01:00")).toBe(
      "0096-02-29T11:00:00.000Z"
    );
    expect(() => canonicalizeTaskScheduledAt("0099-02-29T00:00:00Z")).toThrow(
      "non-existent calendar day"
    );
    expect(() => canonicalizeTaskScheduledAt("0000-04-31T00:00:00Z")).toThrow(
      "non-existent calendar day"
    );
  });

  it("rejects lossy, out-of-range, ambiguous, and malformed values", () => {
    expect(() => serializeTaskDueAt(Number.NaN)).toThrow("safe integer");
    expect(() => serializeTaskDueAt(1.5)).toThrow("safe integer");
    expect(() => serializeTaskDueAt(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("safe integer");
    expect(() => readTaskDueAt({ scheduledAt: "not-a-date" })).toThrow("YYYY-MM-DDTHH:MM:SS.mmmZ");
    expect(() => readTaskDueAt({ scheduledAt: "" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "2030-03-17 17:46:45.000Z" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "2030-03-17T17:46:45.000" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "2030-03-17" })).toThrow("ISO-8601");
    expect(() => readTaskDueAt({ scheduledAt: "2030-02-30T00:00:00.000Z" })).toThrow(
      "non-existent calendar day"
    );
    expect(() => readTaskDueAt({ scheduledAt: "2030-03-17T25:00:00.000Z" })).toThrow("ISO-8601");
    expect(() => canonicalizeTaskScheduledAt("March 17, 2030")).toThrow("ISO-8601");
    expect(() => canonicalizeTaskScheduledAt(null)).toThrow("ISO-8601");
    expect(() =>
      taskMetadataPatchForWrite({ set: { scheduledAt: "2030-03-17T17:46:45" } })
    ).toThrow("ISO-8601");
  });
});
