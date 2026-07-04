/**
 * Unit coverage asserting the category→icon map covers the frozen
 * NotificationCategory union exactly. Pure, no harness.
 */
import type { NotificationCategory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { CATEGORY_ICON, categoryIcon } from "./category-icon";

// Mirrors the frozen NotificationCategory union — the map must cover it exactly.
const CATEGORIES: NotificationCategory[] = [
  "reminder",
  "task",
  "workflow",
  "agent",
  "approval",
  "message",
  "health",
  "system",
  "general",
];

describe("category-icon (#10697)", () => {
  it("maps every notification category to a defined icon, and only those", () => {
    for (const category of CATEGORIES) {
      expect(CATEGORY_ICON[category]).toBeTruthy();
    }
    expect(Object.keys(CATEGORY_ICON).sort()).toEqual([...CATEGORIES].sort());
  });

  it("returns the category's own icon element", () => {
    expect(categoryIcon("message")).toBe(CATEGORY_ICON.message);
    expect(categoryIcon("reminder")).toBe(CATEGORY_ICON.reminder);
    // Distinct categories map to distinct icon elements.
    expect(CATEGORY_ICON.message).not.toBe(CATEGORY_ICON.reminder);
  });

  it("falls back to the general icon for an unrecognized category", () => {
    expect(categoryIcon("bogus" as NotificationCategory)).toBe(
      CATEGORY_ICON.general,
    );
  });
});
