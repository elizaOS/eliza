import { describe, expect, it } from "vitest";
import {
  scoreActionSet,
  scoreLifeOpsTask,
  scoreStructuredFields,
} from "./scoring.js";

/** Unit coverage for the LifeOps per-capability scorers (#8795 item 4). */

describe("scoreStructuredFields", () => {
  it("scores a perfect extraction as 1.0", () => {
    const obj = JSON.stringify({
      title: "Lunch",
      start: "2026-06-23T12:00:00Z",
      recurrence: null,
    });
    expect(scoreStructuredFields(obj, obj)).toBe(1);
  });

  it("gives partial credit per matched field", () => {
    const expected = JSON.stringify({ title: "Lunch", start: "noon", end: "1pm" });
    const actual = JSON.stringify({ title: "Lunch", start: "noon", end: "2pm" });
    // 2 of 3 fields match.
    expect(scoreStructuredFields(actual, expected)).toBeCloseTo(2 / 3, 5);
  });

  it("tolerates code fences and surrounding prose", () => {
    const expected = JSON.stringify({ priority: "high", category: "billing" });
    const actual =
      "Here you go:\n```json\n" +
      JSON.stringify({ priority: "high", category: "billing" }) +
      "\n```";
    expect(scoreStructuredFields(actual, expected)).toBe(1);
  });

  it("is case/whitespace-insensitive on scalar values", () => {
    expect(
      scoreStructuredFields(
        JSON.stringify({ channel: " Push " }),
        JSON.stringify({ channel: "push" }),
      ),
    ).toBe(1);
  });

  it("scores only the requested fields when given", () => {
    const expected = JSON.stringify({ start: "noon", end: "1pm", note: "x" });
    const actual = JSON.stringify({ start: "noon", end: "9pm", note: "y" });
    expect(scoreStructuredFields(actual, expected, ["start"])).toBe(1);
    expect(scoreStructuredFields(actual, expected, ["start", "end"])).toBe(0.5);
  });

  it("returns 0 when the expected output is unparseable", () => {
    expect(scoreStructuredFields("{}", "not json")).toBe(0);
  });
});

describe("scoreActionSet", () => {
  it("scores identical action sets as 1.0", () => {
    const a = JSON.stringify({ action: "ARCHIVE", category: "promo" });
    expect(scoreActionSet(a, a)).toBe(1);
  });

  it("scores disjoint action sets as 0", () => {
    expect(
      scoreActionSet(
        JSON.stringify({ action: "ARCHIVE" }),
        JSON.stringify({ action: "REPLY" }),
      ),
    ).toBe(0);
  });

  it("gives Jaccard partial credit on overlapping sets", () => {
    // {reply, urgent} vs {reply, low} -> intersection 1, union 3 -> 1/3.
    expect(scoreActionSet("reply urgent", "reply low")).toBeCloseTo(1 / 3, 5);
  });
});

describe("scoreLifeOpsTask", () => {
  it("uses structured-field match for extraction tasks", () => {
    const expected = JSON.stringify({ title: "Lunch", start: "noon" });
    const actual = JSON.stringify({ title: "Lunch", start: "1pm" });
    expect(scoreLifeOpsTask("calendar_extract", actual, expected)).toBe(0.5);
  });

  it("falls back to token agreement for the chat-shaped morning brief", () => {
    const text = "Top priority: ship the release. Then review inbox.";
    expect(scoreLifeOpsTask("morning_brief", text, text)).toBe(1);
  });
});
