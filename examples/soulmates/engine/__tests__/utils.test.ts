import { describe, expect, it } from "vitest";
import {
  clampInt,
  clampNumber,
  createRng,
  hashString,
  isoNow,
  unique,
} from "../utils";

describe("clampNumber", () => {
  it("should clamp value to min when below range", () => {
    expect(clampNumber(-5, 0, 10)).toBe(0);
  });

  it("should clamp value to max when above range", () => {
    expect(clampNumber(15, 0, 10)).toBe(10);
  });

  it("should return value when within range", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
  });

  it("should handle negative ranges", () => {
    expect(clampNumber(-5, -10, -2)).toBe(-5);
    expect(clampNumber(-15, -10, -2)).toBe(-10);
  });

  it("should handle zero", () => {
    expect(clampNumber(0, -5, 5)).toBe(0);
  });
});

describe("clampInt", () => {
  it("should round and clamp", () => {
    expect(clampInt(4.7, 0, 10)).toBe(5);
    expect(clampInt(15.3, 0, 10)).toBe(10);
    expect(clampInt(-2.8, 0, 10)).toBe(0);
  });

  it("should handle boundary values", () => {
    expect(clampInt(0.4, 0, 10)).toBe(0);
    expect(clampInt(0.6, 0, 10)).toBe(1);
  });
});

describe("unique", () => {
  it("should remove duplicates", () => {
    expect(unique([1, 2, 2, 3, 1, 4])).toEqual([1, 2, 3, 4]);
  });

  it("should handle empty array", () => {
    expect(unique([])).toEqual([]);
  });

  it("should preserve order", () => {
    expect(unique([3, 1, 2, 1, 3])).toEqual([3, 1, 2]);
  });

  it("should work with strings", () => {
    expect(unique(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("hashString", () => {
  it("should generate consistent hash for same input", () => {
    const hash1 = hashString("test");
    const hash2 = hashString("test");
    expect(hash1).toBe(hash2);
  });

  it("should generate different hashes for different inputs", () => {
    const hash1 = hashString("test1");
    const hash2 = hashString("test2");
    expect(hash1).not.toBe(hash2);
  });

  it("should handle empty string", () => {
    const hash = hashString("");
    expect(hash).toBe(0);
  });

  it("should generate non-negative integers", () => {
    const hash = hashString("test");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hash)).toBe(true);
  });
});

describe("createRng", () => {
  it("should generate consistent random sequence for same seed", () => {
    const rng1 = createRng(42);
    const rng2 = createRng(42);
    const seq1 = [rng1.next(), rng1.next(), rng1.next()];
    const seq2 = [rng2.next(), rng2.next(), rng2.next()];
    expect(seq1).toEqual(seq2);
  });

  it("should generate different sequences for different seeds", () => {
    const rng1 = createRng(42);
    const rng2 = createRng(99);
    const seq1 = [rng1.next(), rng1.next(), rng1.next()];
    const seq2 = [rng2.next(), rng2.next(), rng2.next()];
    expect(seq1).not.toEqual(seq2);
  });

  it("should generate numbers in [0, 1) range", () => {
    const rng = createRng(42);
    for (let i = 0; i < 100; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("should generate integers in specified range", () => {
    const rng = createRng(42);
    for (let i = 0; i < 100; i++) {
      const value = rng.int(5, 10);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(10);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("should handle inverted int range gracefully", () => {
    const rng = createRng(42);
    const value = rng.int(10, 5);
    expect(value).toBe(10);
  });

  it("should generate booleans with specified probability", () => {
    const rng = createRng(42);
    const results = Array.from({ length: 1000 }, () => rng.bool(0.7));
    const trueCount = results.filter((v) => v).length;
    expect(trueCount).toBeGreaterThan(600);
    expect(trueCount).toBeLessThan(800);
  });

  it("should pick items uniformly", () => {
    const rng = createRng(42);
    const items = ["a", "b", "c"];
    const picks = Array.from({ length: 300 }, () => rng.pick(items));
    const counts = { a: 0, b: 0, c: 0 };
    for (const pick of picks) {
      counts[pick as keyof typeof counts]++;
    }
    expect(counts.a).toBeGreaterThan(50);
    expect(counts.b).toBeGreaterThan(50);
    expect(counts.c).toBeGreaterThan(50);
  });

  it("should throw when picking from empty array", () => {
    const rng = createRng(42);
    expect(() => rng.pick([])).toThrow("pick called with empty array");
  });

  it("should pick weighted items according to weights", () => {
    const rng = createRng(42);
    const items = [
      { item: "rare", weight: 0.1 },
      { item: "common", weight: 0.9 },
    ];
    const picks = Array.from({ length: 1000 }, () => rng.pickWeighted(items));
    const commonCount = picks.filter((p) => p === "common").length;
    expect(commonCount).toBeGreaterThan(800);
    expect(commonCount).toBeLessThan(950);
  });

  it("should handle zero total weight gracefully", () => {
    const rng = createRng(42);
    const items = [
      { item: "a", weight: 0 },
      { item: "b", weight: 0 },
    ];
    expect(() => rng.pickWeighted(items)).not.toThrow();
  });

  it("should throw when picking weighted from empty array", () => {
    const rng = createRng(42);
    expect(() => rng.pickWeighted([])).toThrow(
      "pickWeighted called with empty array",
    );
  });

  it("should shuffle array deterministically", () => {
    const rng1 = createRng(42);
    const rng2 = createRng(42);
    const arr = [1, 2, 3, 4, 5];
    const shuffled1 = rng1.shuffle(arr);
    const shuffled2 = rng2.shuffle(arr);
    expect(shuffled1).toEqual(shuffled2);
    expect(shuffled1).not.toEqual(arr);
  });

  it("should not mutate original array when shuffling", () => {
    const rng = createRng(42);
    const arr = [1, 2, 3, 4, 5];
    const original = [...arr];
    rng.shuffle(arr);
    expect(arr).toEqual(original);
  });

  it("should preserve all elements when shuffling", () => {
    const rng = createRng(42);
    const arr = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(arr);
    expect(shuffled.sort()).toEqual(arr.sort());
  });
});

describe("isoNow", () => {
  it("should return ISO 8601 formatted timestamp", () => {
    const timestamp = isoNow();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("should return different values when called sequentially", async () => {
    const t1 = isoNow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const t2 = isoNow();
    expect(t1).not.toBe(t2);
  });
});
