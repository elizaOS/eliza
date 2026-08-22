/** Tests complete task-label normalization through its production helper. */

import { describe, expect, it } from "vitest";
import { labelFrom } from "../../src/actions/task-label.js";

describe("orchestrator label normalization", () => {
  it("keeps the complete instruction beyond the former 80-character cap", () => {
    const input = `${"a".repeat(79)}🦊${"b".repeat(40)} task-tail`;
    const output = labelFrom(input, 0);
    expect(output.isWellFormed()).toBe(true);
    expect(output).toBe(input);
    expect(output).toContain("task-tail");
  });

  it("normalizes whitespace and malformed Unicode", () => {
    const output = labelFrom(`task\n${String.fromCharCode(0xd800)}\tlabel`, 0);
    expect(output.isWellFormed()).toBe(true);
    expect(output).toBe("task \uFFFD label");
  });

  it("uses the indexed fallback only for empty content", () => {
    expect(labelFrom("", 5)).toBe("task-6");
  });
});
