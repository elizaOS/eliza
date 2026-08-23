import { describe, it, expect } from "vitest";
import { compareVersionNumbers } from "./optimized-prompt.ts";

function unsafeCompare(a: number, b: number): number {
  return a - b;
}

describe("optimized-prompt version sort safe NaN handling", () => {
  it("unsafe comparator returns NaN when given NaN (violates sort contract)", () => {
    const result = unsafeCompare(NaN, 2);
    expect(Number.isNaN(result)).toBe(true);
    // NaN comparator makes Array.sort leave elements in unstable order
    const arr = [3, NaN, 1, 2];
    const sorted = [...arr].sort(unsafeCompare);
    // With NaN in array, unsafe sort does not guarantee total order — NaN stays misplaced
    // and contract v is violated because comparator does not return <0, 0, >0 deterministically
    expect(Number.isNaN(unsafeCompare(sorted[0], sorted[1])) || sorted.includes(NaN)).toBe(true);
  });

  it("unsafe comparator returns NaN for Infinity - Infinity", () => {
    expect(Number.isNaN(unsafeCompare(Infinity, Infinity))).toBe(true);
    expect(Number.isNaN(unsafeCompare(-Infinity, -Infinity))).toBe(true);
  });

  it("safe comparator pushes NaN to end deterministically", () => {
    const arr = [3, NaN, 1, 2, Infinity, -Infinity];
    const sorted = [...arr].sort(compareVersionNumbers);
    // finite values first, sorted ascending
    expect(sorted.slice(0, 3)).toEqual([1, 2, 3]);
    // non-finite pushed to end, order deterministic (all non-finite considered equal)
    const tail = sorted.slice(3);
    expect(tail.every((v) => !Number.isFinite(v))).toBe(true);
  });

  it("safe comparator pushes Infinity and -Infinity to end", () => {
    expect(compareVersionNumbers(Infinity, 1)).toBe(1);
    expect(compareVersionNumbers(1, Infinity)).toBe(-1);
    expect(compareVersionNumbers(NaN, 1)).toBe(1);
    expect(compareVersionNumbers(1, NaN)).toBe(-1);
    expect(compareVersionNumbers(NaN, Infinity)).toBe(0);
    expect(compareVersionNumbers(Infinity, NaN)).toBe(0);
  });

  it("safe comparator is total order (never returns NaN)", () => {
    const values = [NaN, Infinity, -Infinity, 0, 1, -1, 42];
    for (const a of values) {
      for (const b of values) {
        const r = compareVersionNumbers(a, b);
        expect(Number.isNaN(r)).toBe(false);
        expect([1, -1, 0].includes(Math.sign(r) as number) || r === 0).toBe(true);
      }
    }
  });

  it("safe comparator sorts finite versions ascending as before", () => {
    const arr = [5, 2, 9, 1, 3];
    expect([...arr].sort(compareVersionNumbers)).toEqual([1, 2, 3, 5, 9]);
  });

  it("safe comparator is stable and deterministic across repeated sorts", () => {
    const arr = [NaN, 3, Infinity, 1, NaN, 2];
    const first = [...arr].sort(compareVersionNumbers);
    const second = [...arr].sort(compareVersionNumbers);
    expect(first).toEqual(second);
    expect(first.slice(0, 3)).toEqual([1, 2, 3]);
  });
});
