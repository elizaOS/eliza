/**
 * Regression coverage for chronological dueDate ordering in the Today
 * todos glance (today-todos-data.ts:107).
 *
 * The glance slice is sorted oldest-due first to surface the most overdue
 * item. A non-finite dueDate previously returned NaN and left the slice out
 * of order.
 */
import { describe, expect, it } from "vitest";
import { __testCompareTodoByDueDateAsc as cmp } from "./today-todos-data.ts";

function todo(id: string, dueDate: string) {
  return { id, dueDate } as { id: string; dueDate: string };
}

describe("today todos dueDate ordering", () => {
  it("sorts oldest-due first", () => {
    expect([todo("c", "2026-01-03"), todo("a", "2026-01-01"), todo("b", "2026-01-02")].sort(cmp).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
  it("treats unparseable as 0 oldest", () => {
    expect([todo("b", "not-a-date"), todo("a", "2026-01-02")].sort(cmp)[0].id).toBe("b");
  });
  it("breaks ties by id", () => {
    expect([todo("b", "2026-01-01"), todo("a", "2026-01-01")].sort(cmp).map((t) => t.id)).toEqual(["a", "b"]);
  });
});
