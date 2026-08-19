/** Verifies sparse trajectory I/O normalization with deterministic pure helpers. */

import { describe, expect, it } from "vitest";
import {
  countTrajectoryCallTextLines,
  normalizeTrajectoryCallText,
} from "./trajectory-call-text";

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

  it("reports zero lines when every input or output candidate is absent", () => {
    expect(countTrajectoryCallTextLines()).toBe(0);
    expect(countTrajectoryCallTextLines(undefined, null)).toBe(0);
    expect(countTrajectoryCallTextLines("")).toBe(0);
  });

  it("counts multiline and structured fallbacks without truthiness coercion", () => {
    expect(countTrajectoryCallTextLines(undefined, "first\r\nsecond")).toBe(2);
    expect(countTrajectoryCallTextLines(undefined, { output: false })).toBe(3);
    expect(countTrajectoryCallTextLines(false)).toBe(1);
    expect(countTrajectoryCallTextLines(0)).toBe(1);
  });
});
