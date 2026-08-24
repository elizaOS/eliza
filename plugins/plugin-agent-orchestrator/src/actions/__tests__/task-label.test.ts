import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toWellFormedUnicode: vi.fn((s: string) => s),
}));

vi.mock(
  "@elizaos/core",
  () => ({
    toWellFormedUnicode: mocks.toWellFormedUnicode,
  }),
  { virtual: true },
);

import { labelFrom } from "./task-label.ts";

describe("labelFrom", () => {
  it("normalizes whitespace", () => {
    expect(labelFrom("  fix  the   bug ", 0)).toBe("fix the bug");
  });

  it("falls back to a numbered label for empty input", () => {
    mocks.toWellFormedUnicode.mockReturnValueOnce("");
    expect(labelFrom("   ", 0)).toBe("task-1");
    expect(labelFrom("", 3)).toBe("task-4");
  });
});
