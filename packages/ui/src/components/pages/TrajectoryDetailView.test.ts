/**
 * Covers the trajectory detail view's sparse-record text normalization and the
 * line-count metadata derived from it. The harness is deterministic: the
 * exported pure helpers are called directly, with no runtime, network, or DOM
 * rendering involved, so a missing prompt must never fabricate a line count.
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

  it("serializes falsy non-null payloads instead of dropping them", () => {
    expect(normalizeTrajectoryCallText(false)).toBe("false");
    expect(normalizeTrajectoryCallText(0)).toBe("0");
    expect(normalizeTrajectoryCallText(undefined, false, "later")).toBe(
      "false",
    );
  });
});

describe("countTrajectoryTextLines", () => {
  it("reports zero lines for absent or empty trajectory text", () => {
    expect(countTrajectoryTextLines(undefined)).toBe(0);
    expect(countTrajectoryTextLines(null)).toBe(0);
    expect(countTrajectoryTextLines("")).toBe(0);
    expect(countTrajectoryTextLines("   \n\t  ")).toBe(0);
    expect(
      countTrajectoryTextLines(normalizeTrajectoryCallText(undefined, null)),
    ).toBe(0);
  });

  it("counts real lines truthfully", () => {
    expect(countTrajectoryTextLines("one line")).toBe(1);
    expect(countTrajectoryTextLines("first\nsecond\nthird")).toBe(3);
    expect(countTrajectoryTextLines("trailing\n")).toBe(2);
  });

  it("counts normalized falsy and structured fallbacks", () => {
    expect(countTrajectoryTextLines(normalizeTrajectoryCallText(false))).toBe(
      1,
    );
    expect(countTrajectoryTextLines(normalizeTrajectoryCallText(0))).toBe(1);
    expect(
      countTrajectoryTextLines(
        normalizeTrajectoryCallText(undefined, [
          { role: "user", content: "open notes" },
        ]),
      ),
    ).toBeGreaterThan(1);
  });
});
