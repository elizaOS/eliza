/**
 * Covers the sparse-trajectory rendering boundary of the trajectory detail
 * view: candidate fallback selection and line counting for recorded LLM calls
 * that omit or blank their prompt, message, and output fields. Deterministic
 * pure-function harness — no runtime, network, or DOM is involved.
 */

import { describe, expect, it } from "vitest";
import {
  countTrajectoryTextLines,
  normalizeTrajectoryCallText,
} from "./TrajectoryDetailView";

describe("normalizeTrajectoryCallText", () => {
  it("returns empty text when every candidate is absent", () => {
    expect(normalizeTrajectoryCallText()).toBe("");
    expect(normalizeTrajectoryCallText(undefined, null)).toBe("");
    expect(normalizeTrajectoryCallText(null, undefined, "")).toBe("");
  });

  it("falls through undefined and null primaries to a populated candidate", () => {
    expect(normalizeTrajectoryCallText(undefined, "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText(null, "fallback prompt")).toBe(
      "fallback prompt",
    );
  });

  it("falls through blank and whitespace-only primaries", () => {
    expect(normalizeTrajectoryCallText("", "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText("   \n\t ", "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(
      normalizeTrajectoryCallText("", undefined, [
        { role: "user", content: "message-only input" },
      ]),
    ).toContain('"content": "message-only input"');
  });

  it("treats an empty array as absent but preserves a populated one", () => {
    expect(normalizeTrajectoryCallText([], "fallback prompt")).toBe(
      "fallback prompt",
    );
    expect(normalizeTrajectoryCallText([], [], undefined)).toBe("");
    expect(
      normalizeTrajectoryCallText(undefined, [
        { role: "user", content: "open notes" },
      ]),
    ).toContain('"content": "open notes"');
  });

  it("keeps the first populated candidate rather than a later one", () => {
    expect(normalizeTrajectoryCallText("primary", "fallback")).toBe("primary");
  });

  it("preserves structured fallback data as inspectable JSON", () => {
    expect(normalizeTrajectoryCallText({ tool: "notes.open" })).toBe(
      '{\n  "tool": "notes.open"\n}',
    );
  });

  it("renders a non-serializable payload instead of blanking the panel", () => {
    const cyclic: Record<string, unknown> = { name: "cyclic" };
    cyclic.self = cyclic;
    expect(normalizeTrajectoryCallText(cyclic)).toBe("[object Object]");
  });
});

describe("countTrajectoryTextLines", () => {
  it("reports zero lines for absent normalized text", () => {
    expect(countTrajectoryTextLines("")).toBe(0);
    expect(
      countTrajectoryTextLines(normalizeTrajectoryCallText(undefined, null)),
    ).toBe(0);
  });

  it("counts real lines once text is present", () => {
    expect(countTrajectoryTextLines("one line")).toBe(1);
    expect(countTrajectoryTextLines("first\nsecond")).toBe(2);
    expect(countTrajectoryTextLines("trailing\n")).toBe(2);
  });
});
