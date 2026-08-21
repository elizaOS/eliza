/**
 * What a failed job records about why.
 *
 * `jobs.error` used to hold `error.message` alone. That is how 342 production
 * `agent_delete` failures came to share one 35-byte string — "value.toISOString
 * is not a function" — with nothing to locate the call site from, one of them
 * stuck since 2026-07-07 (#23117). These tests pin the stack being kept, and
 * kept bounded: the same column already has 33 rows over 100 KB from payload
 * dumps, and a grouping query over it failed with
 * `invalid memory alloc request size 1130945444`.
 */
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

  test("bounds the text so a stack cannot become another oversized row", () => {
    const huge = new Error("boom");
    huge.stack = `Error: boom\n${"    at frame\n".repeat(5_000)}`;

    const text = jobErrorText(huge);

    expect(text.length).toBeLessThan(4_200);
    expect(text).toContain("truncated");
    // The head survives: truncation must not cost the message itself.
    expect(text.startsWith("Error: boom")).toBe(true);
  });

  test("does not annotate text that already fits", () => {
    const small = new Error("short");
    small.stack = "Error: short\n    at one frame";

    expect(jobErrorText(small)).not.toContain("truncated");
  });
});
