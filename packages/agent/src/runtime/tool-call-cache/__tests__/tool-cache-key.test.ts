import { describe, expect, it } from "vitest";
import { buildCacheKey, canonicalizeJson } from "../key.ts";

describe("canonicalizeJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe(
      canonicalizeJson({ a: 2, b: 1 }),
    );
  });

  it("normalizes arrays element-wise", () => {
    expect(canonicalizeJson([{ b: 1, a: 2 }, [3, 2]])).toBe(
      canonicalizeJson([{ a: 2, b: 1 }, [3, 2]]),
    );
  });

  it("handles primitives", () => {
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson(42)).toBe("42");
    expect(canonicalizeJson("s")).toBe('"s"');
  });

  it("produces identical output for semantically-equal inputs", () => {
    const a = canonicalizeJson({ x: { y: 1, z: [2, { w: 3 }] } });
    const b = canonicalizeJson({ x: { z: [2, { w: 3 }], y: 1 } });
    expect(a).toBe(b);
  });
});

describe("buildCacheKey", () => {
  it("produces a stable 64-char sha256 hex", () => {
    const key = buildCacheKey("toolA", { a: 1, b: 2 });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("collides for arg shapes that are semantically equal", () => {
    expect(buildCacheKey("t", { a: 1, b: 2 })).toBe(
      buildCacheKey("t", { b: 2, a: 1 }),
    );
  });

  it("differs across tool names", () => {
    expect(buildCacheKey("t1", { a: 1 })).not.toBe(
      buildCacheKey("t2", { a: 1 }),
    );
  });
});
