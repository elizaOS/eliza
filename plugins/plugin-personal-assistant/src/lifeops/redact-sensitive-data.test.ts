/**
 * Pins the reference handling of the lifeops redaction walker: a shared object
 * must be redacted in full at every site, and only a reference back to an open
 * ancestor may collapse to "[Circular]". Deterministic; no mocks.
 */

import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "./redact-sensitive-data.ts";

describe("redactSensitiveData reference handling", () => {
  it("redacts a shared (non-cyclic) reference in full at every site", () => {
    const shared = { note: "plain text" };
    expect(
      redactSensitiveData({ a: shared, b: shared, list: [shared, shared] }),
    ).toEqual({
      a: { note: "plain text" },
      b: { note: "plain text" },
      list: [{ note: "plain text" }, { note: "plain text" }],
    });
  });

  it("still collapses a true cycle to [Circular] and redacts its siblings", () => {
    const root: Record<string, unknown> = { note: "root" };
    root.self = root;
    root.child = { parent: root, note: "child" };
    expect(redactSensitiveData(root)).toEqual({
      note: "root",
      self: "[Circular]",
      child: { parent: "[Circular]", note: "child" },
    });
  });

  it("bounds a shared-reference chain instead of expanding it exponentially", () => {
    // 13 distinct objects, each holding the same next level under four keys:
    // 4^12 paths. The walker returns a structure, so the budget is its only
    // ceiling.
    let level: Record<string, unknown> = { note: "leaf" };
    for (let i = 0; i < 12; i++)
      level = { a: level, b: level, c: level, d: level };
    const started = performance.now();
    const out = redactSensitiveData(level);
    const elapsedMs = performance.now() - started;
    let objects = 0;
    let markers = 0;
    const walk = (value: unknown): void => {
      if (value === "[Truncated]") {
        markers += 1;
        return;
      }
      if (value && typeof value === "object") {
        objects += 1;
        for (const item of Object.values(value)) walk(item);
      }
    };
    walk(out);
    expect(markers).toBeGreaterThan(0);
    expect(objects).toBeLessThanOrEqual(50_000);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
