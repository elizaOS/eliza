/**
 * Tests for calendar action approvalSafeLabel surrogate pair preservation.
 */

import { describe, expect, it } from "vitest";
import { approvalSafeLabel } from "./calendar.ts";

describe("approvalSafeLabel surrogate safety", () => {
  it("truncates approval labels without bisecting surrogate pairs", () => {
    // "x" (1 char) + "📅" (2 chars each * 120 = 240 chars).
    // Index 160 lands right between high and low surrogate of the 80th emoji.
    const bisectingInput = "x" + "📅".repeat(120);
    const label = approvalSafeLabel(bisectingInput);

    // Backs off by 1 to avoid orphan high surrogate at index 159.
    expect(label.length).toBe(159);
    for (const char of label) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });

  it("preserves non-bisecting unicode strings up to length limit", () => {
    const input = "📅".repeat(80); // exactly 160 code units
    const label = approvalSafeLabel(input);
    expect(label.length).toBe(160);
    expect(label).toBe(input);
  });
});
