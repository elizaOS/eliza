/**
 * Tests for probers index — centrally-enumerated native permission probers.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_PROBERS,
  accessibilityProber,
  automationProber,
  PROBERS_BY_ID,
} from "./index.ts";

describe("probers/index", () => {
  it("exports ALL_PROBERS as array", () => {
    expect(Array.isArray(ALL_PROBERS)).toBe(true);
    expect(ALL_PROBERS.length).toBeGreaterThan(10);
  });

  it("contains known probers", () => {
    const ids = ALL_PROBERS.map((p) => p.id);
    expect(ids).toContain("accessibility");
    expect(ids).toContain("automation");
    expect(ids).toContain("calendar");
    expect(ids).toContain("camera");
    expect(ids).toContain("location");
    expect(ids).toContain("microphone");
  });

  it("re-exports individual probers", () => {
    expect(accessibilityProber.id).toBe("accessibility");
    expect(automationProber.id).toBe("automation");
  });

  it("PROBERS_BY_ID maps id to prober", () => {
    expect(PROBERS_BY_ID.get("accessibility")).toBe(accessibilityProber);
    expect(PROBERS_BY_ID.get("automation")).toBe(automationProber);
    expect(PROBERS_BY_ID.size).toBe(ALL_PROBERS.length);
  });

  it("all probers have required methods", () => {
    for (const prober of ALL_PROBERS) {
      expect(typeof prober.id).toBe("string");
      expect(typeof prober.check).toBe("function");
      expect(typeof prober.request).toBe("function");
    }
  });

  it("has no duplicate ids", () => {
    const ids = ALL_PROBERS.map((p) => p.id);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });
});
