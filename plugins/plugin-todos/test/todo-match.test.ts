/**
 * Word-family collapse for visible-content addressing: both sides of a match
 * run the same stemmer, so one word family must land on one token set —
 * otherwise the same todo named in another form of the word counts as a
 * different row (a silent duplicate on create, a missed row on mutation).
 */

import { describe, expect, test } from "vitest";
import { matchTodosByContent, sameTodoContent } from "../src/todo-match.ts";

const todo = (content: string) => ({
  content,
  status: "pending" as const,
});

describe("todo-match word families", () => {
  test("copies and copy are the same todo content", () => {
    expect(
      sameTodoContent(
        "Order copies for the office",
        "Order copy for the office",
      ),
    ).toBe(true);
  });

  test("parties and party are the same todo content", () => {
    expect(sameTodoContent("Plan parties", "Plan party")).toBe(true);
  });

  test("babies and baby are the same todo content", () => {
    expect(sameTodoContent("Feed babies", "Feed baby")).toBe(true);
  });

  test("groceries and grocery are the same todo content", () => {
    expect(sameTodoContent("Buy groceries", "Buy grocery")).toBe(true);
  });

  test("tried and try are the same todo content", () => {
    expect(
      sameTodoContent("Try the new supplier", "Tried the new supplier"),
    ).toBe(true);
  });

  test("a mutation addressed with the singular resolves the plural row", () => {
    const copies = todo("Order copies");
    const picnic = todo("Plan picnic");
    expect(matchTodosByContent("Order copy", [copies, picnic])).toEqual([
      copies,
    ]);
  });

  // Controls: families that already collapse must keep collapsing.
  test("trying and try stay the same todo content", () => {
    expect(
      sameTodoContent("Try the new supplier", "Trying the new supplier"),
    ).toBe(true);
  });

  test("meetings and meeting stay the same todo content", () => {
    expect(sameTodoContent("Schedule meetings", "Schedule meeting")).toBe(true);
  });

  test("movies and movie stay the same todo content", () => {
    expect(sameTodoContent("Watch movies", "Watch movie")).toBe(true);
  });

  test("cookies and cookie stay the same todo content", () => {
    expect(sameTodoContent("Bake cookies", "Bake cookie")).toBe(true);
  });

  test("vowel + y forms stay the same todo content", () => {
    expect(sameTodoContent("Play games", "Plays game")).toBe(true);
  });

  test("distinct todos stay distinct", () => {
    expect(
      sameTodoContent("Buy 12 bolts and 24 nuts", "Buy 24 bolts and 12 nuts"),
    ).toBe(false);
    expect(sameTodoContent("Plan party", "Plan picnic")).toBe(false);
  });
});
