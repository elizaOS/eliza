// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  cloneRecord,
  computeSnoozedUntil,
  isRecord,
  mergeMetadata,
  normalizedStringSet,
  normalizeOptionalRecord,
  requireRecord,
  sameNormalizedStringSet,
} from "../src/lifeops/service-helpers-misc.js";

/**
 * LifeOps misc helpers. String-set normalization (trim + dedupe + sort) backs
 * change-detection so an equivalent set never looks "drifted". mergeMetadata
 * defaults privacyClass to "private" and blocks public context for private
 * items — a privacy-safety default. computeSnoozedUntil turns a snooze request
 * into an absolute time relative to a caller-supplied `now` (deterministic).
 */

describe("normalizedStringSet / sameNormalizedStringSet", () => {
  it("trims, dedupes, and sorts; equality is order-insensitive", () => {
    expect(normalizedStringSet([" b ", "a", "a", ""])).toEqual(["a", "b"]);
    expect(sameNormalizedStringSet(["a", "b"], ["b", " a "])).toBe(true);
    expect(sameNormalizedStringSet(["a"], ["a", "c"])).toBe(false);
  });
});

describe("record guards", () => {
  it("isRecord / cloneRecord / requireRecord / normalizeOptionalRecord", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    const src = { a: 1 };
    const clone = cloneRecord(src);
    expect(clone).toEqual(src);
    expect(clone).not.toBe(src); // shallow copy
    expect(cloneRecord("nope")).toEqual({});
    expect(requireRecord({ x: 1 }, "f")).toEqual({ x: 1 });
    expect(() => requireRecord("bad", "f")).toThrow(/must be an object/);
    expect(normalizeOptionalRecord(undefined, "f")).toBeUndefined();
  });
});

describe("mergeMetadata privacy defaults", () => {
  it("defaults privacyClass to private and blocks public context", () => {
    const merged = mergeMetadata({}, { note: "x" });
    expect(merged.note).toBe("x");
    expect(merged.privacyClass).toBe("private");
    expect(merged.publicContextBlocked).toBe(true);
  });

  it("honors an explicit non-private privacy class", () => {
    const merged = mergeMetadata({ privacyClass: "public" }, {});
    expect(merged.privacyClass).toBe("public");
    expect(merged.publicContextBlocked).toBeUndefined();
  });
});

describe("computeSnoozedUntil", () => {
  const now = new Date("2026-01-02T10:00:00.000Z");
  const def = { timezone: "UTC", windowPolicy: {} } as never;

  it("resolves minute presets relative to now", () => {
    expect(
      computeSnoozedUntil(def, { preset: "15m" } as never, now).getTime(),
    ).toBe(now.getTime() + 15 * 60_000);
    expect(
      computeSnoozedUntil(def, { preset: "1h" } as never, now).getTime(),
    ).toBe(now.getTime() + 60 * 60_000);
  });

  it("uses an explicit minutes value, rejecting non-positive", () => {
    expect(
      computeSnoozedUntil(def, { minutes: 45 } as never, now).getTime(),
    ).toBe(now.getTime() + 45 * 60_000);
    expect(() =>
      computeSnoozedUntil(def, { minutes: 0 } as never, now),
    ).toThrow();
  });
});
