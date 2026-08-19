import { describe, expect, it } from "vitest";
import { normalizeTrajectoryCallText } from "./TrajectoryDetailView";

describe("normalizeTrajectoryCallText", () => {
  it("keeps sparse trajectory calls renderable", () => {
    expect(normalizeTrajectoryCallText(undefined, null)).toBe("");
    expect(normalizeTrajectoryCallText(undefined, "fallback prompt")).toBe(
      "fallback prompt",
    );
  });

  it("preserves structured fallback data as inspectable JSON", () => {
    expect(
      normalizeTrajectoryCallText(undefined, [
        { role: "user", content: "open notes" },
      ]),
    ).toContain('"content": "open notes"');
  });
});
