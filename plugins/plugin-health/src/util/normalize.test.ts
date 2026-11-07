import { describe, expect, it } from "vitest";
import { normalizeOptionalIsoString } from "./normalize.js";

// Pins the canonical-ISO contract shared with the canonical normalizer in
// packages/contracts (lifeops-normalize) and plugin-calendar: parseable
// spellings of the same instant are stored in canonical UTC form, not in
// the caller's spelling.
describe("normalizeOptionalIsoString canonical form", () => {
  const field = "health.sleep.asleepAt";

  it("converts an explicit offset to canonical UTC", () => {
    expect(normalizeOptionalIsoString("2024-06-01T17:30:00+05:30", field)).toBe(
      "2024-06-01T12:00:00.000Z",
    );
  });

  it("converts a date-only value to canonical UTC midnight", () => {
    expect(normalizeOptionalIsoString("2024-06-01", field)).toBe(
      "2024-06-01T00:00:00.000Z",
    );
  });

  it("leaves an already-canonical Z value unchanged", () => {
    expect(normalizeOptionalIsoString("2024-06-01T12:00:00Z", field)).toBe(
      "2024-06-01T12:00:00.000Z",
    );
  });

  it("truncates sub-millisecond precision, matching the canonical normalizer", () => {
    expect(
      normalizeOptionalIsoString("2024-06-01T12:00:00.123456Z", field),
    ).toBe("2024-06-01T12:00:00.123Z");
  });

  it("parses offset-less values with Date.parse semantics, like the canonical normalizer", () => {
    const input = "2024-06-01T12:00:00";
    expect(normalizeOptionalIsoString(input, field)).toBe(
      new Date(Date.parse(input)).toISOString(),
    );
  });

  it("treats empty and missing values as absent", () => {
    expect(normalizeOptionalIsoString("", field)).toBeUndefined();
    expect(normalizeOptionalIsoString(null, field)).toBeUndefined();
    expect(normalizeOptionalIsoString(undefined, field)).toBeUndefined();
  });

  it("rejects blank and unparseable values with a 400", () => {
    expect(() => normalizeOptionalIsoString("   ", field)).toThrowError(
      /non-empty string/,
    );
    expect(() => normalizeOptionalIsoString("garbage", field)).toThrowError(
      /valid ISO timestamp/,
    );
  });
});
