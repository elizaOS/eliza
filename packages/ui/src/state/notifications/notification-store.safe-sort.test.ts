/**
 * Regression coverage for the notification recency comparator shipped by
 * notification-store.ts. Exercises the real exported comparator — a corrupt
 * persisted `createdAt` must not produce a NaN comparison, and equal
 * timestamps must resolve deterministically by id.
 */
import { describe, expect, it } from "vitest";
import { compareNotificationsByRecency } from "./notification-store";

interface SortableNotification {
  id: string;
  createdAt: number;
}

function sortNotifications(
  items: SortableNotification[],
): SortableNotification[] {
  return [...items].sort(compareNotificationsByRecency);
}

describe("compareNotificationsByRecency", () => {
  it("treats a NaN createdAt as the oldest entry instead of returning NaN", () => {
    const nanFirst: SortableNotification = { id: "b", createdAt: Number.NaN };
    const real: SortableNotification = { id: "a", createdAt: 100 };
    expect(Number.isNaN(compareNotificationsByRecency(nanFirst, real))).toBe(
      false,
    );
    expect(compareNotificationsByRecency(nanFirst, real)).toBeGreaterThan(0);
    expect(sortNotifications([nanFirst, real]).map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("tiebreaks equal timestamps by id for a stable order", () => {
    expect(
      sortNotifications([
        { id: "b", createdAt: 100 },
        { id: "a", createdAt: 100 },
      ]).map((n) => n.id),
    ).toEqual(["a", "b"]);
    expect(
      sortNotifications([
        { id: "a", createdAt: 100 },
        { id: "b", createdAt: 100 },
      ]).map((n) => n.id),
    ).toEqual(["a", "b"]);
  });

  it("treats a non-finite Infinity createdAt as the oldest entry", () => {
    expect(
      sortNotifications([
        { id: "a", createdAt: Number.POSITIVE_INFINITY },
        { id: "b", createdAt: 50 },
      ]).map((n) => n.id),
    ).toEqual(["b", "a"]);
  });

  it("still orders finite timestamps newest first", () => {
    expect(
      sortNotifications([
        { id: "old", createdAt: 10 },
        { id: "new", createdAt: 900 },
        { id: "mid", createdAt: 400 },
      ]).map((n) => n.id),
    ).toEqual(["new", "mid", "old"]);
  });
});
