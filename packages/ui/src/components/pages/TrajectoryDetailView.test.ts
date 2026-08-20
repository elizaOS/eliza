/**
 * Verifies sparse trajectory payload normalization and truthful line counts.
 * These focused helpers are the fail-safe boundary for legacy/provider rows
 * that legitimately omit prompts or responses.
 */

import { describe, expect, it } from "vitest";
import {
  countTrajectoryTextLines,
  normalizeTrajectoryCallText,
} from "./TrajectoryDetailView";

describe("normalizeTrajectoryCallText", () => {
  it("keeps sparse trajectory calls renderable", () => {
    expect(normalizeTrajectoryCallText(undefined, null)).toBe("");
    expect(normalizeTrajectoryCallText(undefined, "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(
      normalizeTrajectoryCallText("", undefined, [
        { role: "user", content: "message-only input" },
      ]),
    ).toContain('"content": "message-only input"');
  });

  it("preserves structured fallback data as inspectable JSON", () => {
    expect(
      normalizeTrajectoryCallText(undefined, [
        { role: "user", content: "open notes" },
      ]),
    ).toContain('"content": "open notes"');
  });
});

describe("countTrajectoryTextLines", () => {
  it("does not advertise a line for absent payloads", () => {
    expect(countTrajectoryTextLines(undefined)).toBe(0);
    expect(countTrajectoryTextLines(null)).toBe(0);
    expect(countTrajectoryTextLines("")).toBe(0);
  });

  it("counts actual one-line and multiline payloads", () => {
    expect(countTrajectoryTextLines("hello")).toBe(1);
    expect(countTrajectoryTextLines("first\nsecond\nthird")).toBe(3);
  });
});
