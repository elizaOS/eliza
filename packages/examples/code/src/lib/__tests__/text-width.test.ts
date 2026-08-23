import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/tui", () => ({
  visibleWidth: (s: string) => s.length,
}));

import { padEndVisible } from "./text-width.ts";

describe("padEndVisible", () => {
  it("pads to the visible width", () => {
    expect(padEndVisible("ab", 4)).toBe("ab  ");
  });

  it("leaves overflowing strings untouched", () => {
    expect(padEndVisible("abcdef", 4)).toBe("abcdef");
  });

  it("handles exact widths", () => {
    expect(padEndVisible("ab", 2)).toBe("ab");
  });
});
