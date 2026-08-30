/** Durable private job diagnostics retain complete operator evidence; owner-facing projection is tested separately. */
import { describe, expect, test } from "bun:test";
import { jobErrorText } from "./job-error-text";

describe("jobErrorText", () => {
  test("keeps the stack, which is the part that locates the bug", () => {
    function throwingFrame(): never {
      throw new TypeError("value.toISOString is not a function");
    }

    let captured: unknown;
    try {
      throwingFrame();
    } catch (error) {
      captured = error;
    }

    const text = jobErrorText(captured);

    expect(text).toContain("value.toISOString is not a function");
    // The message alone was never the problem — this is the half that was missing.
    expect(text).toContain("throwingFrame");
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  test("falls back to the message when an Error carries no stack", () => {
    const bald = new Error("no stack here");
    bald.stack = undefined;

    expect(jobErrorText(bald)).toBe("no stack here");
  });

  test("accepts a thrown non-Error without losing it", () => {
    expect(jobErrorText("plain string")).toBe("plain string");
    expect(jobErrorText(42)).toBe("42");
    expect(jobErrorText(null)).toBe("null");
  });

  test("preserves a large stack without truncating operator evidence", () => {
    const huge = new Error("boom");
    huge.stack = `Error: boom\n${"    at frame\n".repeat(5_000)}`;

    const text = jobErrorText(huge);

    expect(text).toBe(huge.stack.trim());
    expect(text).not.toContain("truncated");
    expect(text.startsWith("Error: boom")).toBe(true);
  });

  test("does not annotate text that already fits", () => {
    const small = new Error("short");
    small.stack = "Error: short\n    at one frame";

    expect(jobErrorText(small)).not.toContain("truncated");
  });
});
