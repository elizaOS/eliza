/**
 * Verifies sparse trajectory I/O normalization and line counts with
 * deterministic pure helpers rather than a mocked application shell.
 */
import { describe, expect, it } from "vitest";
import {
  countTrajectoryCallTextLines,
  normalizeTrajectoryCallText,
} from "./TrajectoryDetailView";

describe("normalizeTrajectoryCallText", () => {
  it("keeps sparse trajectory calls renderable", () => {
    expect(normalizeTrajectoryCallText(undefined, null)).toBe("");
    expect(normalizeTrajectoryCallText(undefined, "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText("", "legacy prompt")).toBe(
      "legacy prompt",
    );
    expect(normalizeTrajectoryCallText("   ", "legacy prompt")).toBe(
      "legacy prompt",
    );
    expect(
      normalizeTrajectoryCallText("", undefined, ["fallback message"]),
    ).toContain("fallback message");
    expect(normalizeTrajectoryCallText("", 0)).toBe("0");
    expect(normalizeTrajectoryCallText("", false)).toBe("false");
  });

  it("preserves structured fallback data as inspectable JSON", () => {
    expect(
      normalizeTrajectoryCallText(undefined, [
        { role: "user", content: "open notes" },
      ]),
    ).toContain('"content": "open notes"');
  });

  it("reports zero lines for absent payloads and exact lines for content", () => {
    expect(countTrajectoryCallTextLines()).toBe(0);
    expect(countTrajectoryCallTextLines(undefined, null, "")).toBe(0);
    expect(countTrajectoryCallTextLines("   ")).toBe(0);
    expect(countTrajectoryCallTextLines("", "fallback prompt")).toBe(1);
    expect(countTrajectoryCallTextLines("first\r\nsecond")).toBe(2);
    expect(countTrajectoryCallTextLines(false)).toBe(1);
    expect(countTrajectoryCallTextLines(0)).toBe(1);
  });
});
