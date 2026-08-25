/** Deterministic coverage for conflict-detect timestamp offset validation. */

import { describe, expect, it } from "vitest";
import { hasExplicitOffset } from "./conflict-detect.js";

describe("hasExplicitOffset", () => {
  it.each([
    "2026-01-01T10:00:00Z",
    "2026-01-01t10:00:00z",
    "2026-01-01t10:00:00Z",
    "2026-01-01T10:00:00z",
    "2026-01-01t10:00:00+05:30",
    "2026-01-01t10:00:00-0800",
  ])("accepts RFC 3339 timestamp with explicit offset: %s", (value) => {
    expect(hasExplicitOffset(value)).toBe(true);
  });

  it.each([
    "2026-01-01T10:00:00",
    "2026-01-01t10:00:00",
    "2026-01-01",
    "2026-01-01T",
    "10:00:00Z",
  ])("rejects timestamp without explicit offset: %s", (value) => {
    expect(hasExplicitOffset(value)).toBe(false);
  });
});
