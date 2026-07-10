/**
 * Unit tests for the ambient build-flag reader.
 */

import { describe, expect, it } from "vitest";
import { readAmbientFlag } from "./ambient-flag";

describe("readAmbientFlag", () => {
  it("returns the default when unset", () => {
    expect(readAmbientFlag("X", false, {})).toBe(false);
    expect(readAmbientFlag("X", true, {})).toBe(true);
    expect(readAmbientFlag("X", false, undefined)).toBe(false);
  });

  it("treats anything but the literal 'false' as enabled", () => {
    expect(readAmbientFlag("X", false, { X: "true" })).toBe(true);
    expect(readAmbientFlag("X", false, { X: "1" })).toBe(true);
    expect(readAmbientFlag("X", true, { X: "false" })).toBe(false);
    expect(readAmbientFlag("X", true, { X: "FALSE" })).toBe(false);
  });
});
