/**
 * Exercises truncate suffix reservation: payload must not exceed advertised max.
 */
import { describe, expect, it } from "vitest";
import { truncate } from "./orchestrator-task-service";

describe("orchestrator truncate", () => {
  it("never exceeds max inclusive of suffix", () => {
    const text = "a".repeat(2001);
    const out = truncate(text, 2000);
    expect(out.length).toBe(2000);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns original when under cap", () => {
    const text = "a".repeat(100);
    expect(truncate(text, 2000)).toBe(text);
  });

  it("handles small max correctly", () => {
    expect(truncate("hello world", 5).length).toBe(5);
    expect(truncate("hello world", 5).endsWith("…")).toBe(true);
    expect(truncate("hi", 5)).toBe("hi");
  });

  it("handles max=1 edge", () => {
    const out = truncate("abc", 1);
    expect(out.length).toBe(1);
    expect(out).toBe("…");
  });
});
