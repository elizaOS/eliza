/**
 * Unit pins for the cutover/recovery timestamp unit fence (#17919).
 * Leaf module only — no full jobs repository import graph.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  cutoverResumeWindowAllows,
  msWindowTimestampMatch,
} from "./job-timestamp-fence";

describe("cutover audit timestamp units (#17919)", () => {
  test("ms-window SQL fragment truncates the column before comparing", () => {
    const expected = new Date("2026-08-06T12:00:00.123Z");
    const fragment = msWindowTimestampMatch(sql`updated_at`, expected);
    const shape = fragment.queryChunks
      .map((chunk) => {
        if (
          chunk &&
          typeof chunk === "object" &&
          "value" in chunk &&
          Array.isArray((chunk as { value: unknown }).value)
        ) {
          return (chunk as { value: string[] }).value.join("");
        }
        return "";
      })
      .join("");
    expect(shape).toContain("date_trunc('milliseconds'");
    expect(shape).toContain("IS NOT DISTINCT FROM");
  });

  test("resume window accepts epoch-ms ordering and rejects µs-scale inputs", () => {
    const cutoverAtMs = Date.parse("2026-08-06T12:00:00.000Z");
    const rowStartedAtMs = cutoverAtMs + 5_000;
    const rowUpdatedAtMs = rowStartedAtMs + 1_000;
    expect(
      cutoverResumeWindowAllows({
        cutoverAtMs,
        rowStartedAtMs,
        rowUpdatedAtMs,
      }),
    ).toBe(true);

    // Same chronology but encoded as microseconds — must fail closed.
    expect(
      cutoverResumeWindowAllows({
        cutoverAtMs: cutoverAtMs * 1000,
        rowStartedAtMs: rowStartedAtMs * 1000,
        rowUpdatedAtMs: rowUpdatedAtMs * 1000,
      }),
    ).toBe(false);

    expect(
      cutoverResumeWindowAllows({
        cutoverAtMs: rowStartedAtMs + 1,
        rowStartedAtMs,
        rowUpdatedAtMs,
      }),
    ).toBe(false);
  });
});
