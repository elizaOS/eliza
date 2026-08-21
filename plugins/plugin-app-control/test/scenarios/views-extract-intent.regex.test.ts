/**
 * Tests for views natural language intent parser regex safety.
 */

import { describe, expect, it } from "vitest";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractIntentTextAfter(
  intent: string,
  labels: readonly string[],
): string | null {
  for (const label of labels) {
    const match = new RegExp(
      `\\b(?:with\\s+)?${escapeRegExp(label)}\\s+(.+)$`,
      "i",
    ).exec(intent);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

describe("views extractIntentTextAfter regex safety", () => {
  it("extracts text after standard labels", () => {
    expect(extractIntentTextAfter("create a view titled My View", ["titled", "named"])).toBe("My View");
    expect(extractIntentTextAfter("add view with name Test Board", ["name", "title"])).toBe("Test Board");
  });

  it("handles labels containing regex metacharacters without throwing or corrupting match", () => {
    expect(extractIntentTextAfter("view with title(optional) My Dashboard", ["title(optional)"])).toBe("My Dashboard");
    expect(extractIntentTextAfter("open view with [id] 12345", ["[id]"])).toBe("12345");
    expect(extractIntentTextAfter("show view with tag+label urgent", ["tag+label"])).toBe("urgent");
    expect(extractIntentTextAfter("filter view with field$name status", ["field$name"])).toBe("status");
  });

  it("returns null when no label matches", () => {
    expect(extractIntentTextAfter("show all views", ["titled", "named"])).toBeNull();
  });
});
