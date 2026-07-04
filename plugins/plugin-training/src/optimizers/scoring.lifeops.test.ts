// Exercises prompt-optimizer scoring and view-switching dataset behavior.
import { describe, expect, it } from "vitest";
import { LIFEOPS_TRAINING_TASKS } from "../core/trajectory-task-datasets.js";
import {
  LIFEOPS_SCORER_TASKS,
  LIFEOPS_STRUCTURED_SCORER_TASKS,
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
    const expected = JSON.stringify({
      title: "Lunch",
      start: "noon",
      end: "1pm",
    });
    const actual = JSON.stringify({
      title: "Lunch",
      start: "noon",
      end: "2pm",
    });
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

  it("scores line-based planner fields", () => {
    const expected = [
      "subaction: needs_response",
      "shouldAct: true",
      "queries: legal || finance",
    ].join("\n");
    const actual = [
      "subaction: needs_response",
      "shouldAct: true",
      "queries: legal || finance",
    ].join("\n");
    expect(scoreStructuredFields(actual, expected)).toBe(1);
  });

  it("gives partial credit for line-based planner fields", () => {
    const expected = [
      "subaction: draft_reply",
      "shouldAct: true",
      "queries: Mia deck",
    ].join("\n");
    const actual = [
      "subaction: search",
      "shouldAct: true",
      "queries: Mia deck",
    ].join("\n");
    expect(scoreStructuredFields(actual, expected)).toBeCloseTo(2 / 3, 5);
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

describe("scoreStructuredFields — edge cases & discriminative guarantees (#8795)", () => {
  it("scores two empty objects as 1.0 (both correctly produced nothing)", () => {
    expect(scoreStructuredFields("{}", "{}")).toBe(1);
  });

  it("scores an empty expected against a non-empty actual as 0", () => {
    expect(scoreStructuredFields(JSON.stringify({ a: 1 }), "{}")).toBe(0);
  });

  it("matches a number against its string form (model may emit either)", () => {
    expect(
      scoreStructuredFields(
        JSON.stringify({ minSamples: 5 }),
        JSON.stringify({ minSamples: "5" }),
      ),
    ).toBe(1);
  });

  it("treats a null-expected field the actual omits as matched (both absent)", () => {
    // Characterization: normalizeScalar(null) === normalizeScalar(undefined) === "".
    expect(
      scoreStructuredFields(
        JSON.stringify({ title: "Lunch" }),
        JSON.stringify({ title: "Lunch", recurrence: null }),
      ),
    ).toBe(1);
  });

  it("does NOT credit a present value against a null expectation", () => {
    expect(
      scoreStructuredFields(
        JSON.stringify({ recurrence: "FREQ=DAILY" }),
        JSON.stringify({ recurrence: null }),
      ),
    ).toBe(0);
  });

  it("is discriminative: a fully-wrong extraction scores strictly below a correct one", () => {
    const expected = JSON.stringify({
      title: "Dentist",
      start: "9am",
      end: "10am",
    });
    const wrong = JSON.stringify({ title: "Lunch", start: "noon", end: "1pm" });
    expect(scoreStructuredFields(expected, expected)).toBe(1);
    expect(scoreStructuredFields(wrong, expected)).toBeLessThan(
      scoreStructuredFields(expected, expected),
    );
    expect(scoreStructuredFields(wrong, expected)).toBe(0);
  });

  it("a degenerate empty actual cannot pass a non-empty expectation", () => {
    const expected = JSON.stringify({ title: "X", start: "y" });
    expect(scoreStructuredFields("", expected)).toBe(0);
    expect(scoreStructuredFields("{}", expected)).toBe(0);
  });

  it("nested-object equality is structural and key-order-sensitive (characterization)", () => {
    // Documents a real weakness: semantically-equal nested objects with a
    // different key order score 0 (JSON.stringify is order-sensitive).
    const a = JSON.stringify({ attendees: { lead: "amy", note: "x" } });
    const b = JSON.stringify({ attendees: { note: "x", lead: "amy" } });
    expect(scoreStructuredFields(a, b)).toBe(0);
    expect(scoreStructuredFields(a, a)).toBe(1);
  });

  it("array values are order-sensitive (characterization)", () => {
    const a = JSON.stringify({ attendees: ["amy", "bob"] });
    const b = JSON.stringify({ attendees: ["bob", "amy"] });
    expect(scoreStructuredFields(a, b)).toBe(0);
  });
});

describe("scoreActionSet — edge cases & discriminative guarantees (#8795)", () => {
  it("scores two empty/none outputs as 1.0", () => {
    expect(scoreActionSet("", "")).toBe(1);
    expect(scoreActionSet("{}", "{}")).toBe(1);
  });

  it("a do-nothing actual cannot pass a real expected action set", () => {
    const expected = JSON.stringify({ action: "ARCHIVE" });
    expect(scoreActionSet("", expected)).toBe(0);
    expect(scoreActionSet("{}", expected)).toBe(0);
  });

  it("extracts action/category fields from JSON for set overlap", () => {
    // {archive, promo} vs {archive, billing} -> intersection 1, union 3 -> 1/3.
    expect(
      scoreActionSet(
        JSON.stringify({ action: "archive", category: "promo" }),
        JSON.stringify({ action: "archive", category: "billing" }),
      ),
    ).toBeCloseTo(1 / 3, 5);
  });

  it("is discriminative: a wrong action set scores below the right one", () => {
    const expected = JSON.stringify({ action: "REPLY", priority: "high" });
    const wrong = JSON.stringify({ action: "DELETE", priority: "low" });
    expect(scoreActionSet(expected, expected)).toBe(1);
    expect(scoreActionSet(wrong, expected)).toBeLessThan(
      scoreActionSet(expected, expected),
    );
  });
});

describe("scoreLifeOpsTask", () => {
  it("registers every LifeOps trajectory task for per-capability scoring", () => {
    expect([...LIFEOPS_SCORER_TASKS].sort()).toEqual(
      [...LIFEOPS_TRAINING_TASKS].sort(),
    );
  });

  it.each(
    LIFEOPS_STRUCTURED_SCORER_TASKS,
  )("uses structured-field match for %s", (task) => {
    const expected = JSON.stringify({ title: "Lunch", start: "noon" });
    const actual = JSON.stringify({ title: "Lunch", start: "1pm" });
    expect(scoreLifeOpsTask(task, actual, expected)).toBe(0.5);
  });

  it("falls back to token agreement for the chat-shaped morning brief", () => {
    const text = "Top priority: ship the release. Then review inbox.";
    expect(scoreLifeOpsTask("morning_brief", text, text)).toBe(1);
  });
});
