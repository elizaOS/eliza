/**
 * Deterministic coverage for the GenUI unsafe-field walk budget. The fuzz
 * harness already requires `validateElizaGenUiSpec` never to throw; these
 * cases pin the 4k/20k nests that RangeError on origin Node.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_GENUI_UNSAFE_FIELD_DEPTH,
  MAX_GENUI_UNSAFE_FIELD_NODES,
  validateElizaGenUiSpec,
} from "./validator";

function nestData(depth: number): unknown {
  let value: unknown = { leaf: true };
  for (let i = 0; i < depth; i++) {
    value = { child: value };
  }
  return value;
}

function specWithData(data: unknown) {
  return {
    version: "0.1",
    root: "root",
    components: [{ id: "root", component: "Text", text: "ok" }],
    data,
  };
}

describe("validateElizaGenUiSpec unbounded nests", () => {
  it("accepts a shallow honest data object", () => {
    const result = validateElizaGenUiSpec(
      specWithData({ title: "Sleep", hours: 8 }),
    );
    expect(result.ok).toBe(true);
  });

  it(`rejects a ${MAX_GENUI_UNSAFE_FIELD_DEPTH + 1}-deep data nest without throwing`, () => {
    const result = validateElizaGenUiSpec(
      specWithData(nestData(MAX_GENUI_UNSAFE_FIELD_DEPTH + 1)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "unbounded_nest"),
      ).toBe(true);
    }
  });

  it("rejects a 4000-deep stringifyable nest without RangeError", () => {
    const t0 = performance.now();
    expect(() => {
      const result = validateElizaGenUiSpec(specWithData(nestData(4000)));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((error) => error.code === "unbounded_nest"),
        ).toBe(true);
      }
    }).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it(`rejects more than ${MAX_GENUI_UNSAFE_FIELD_NODES} sibling nodes`, () => {
    const siblings: Record<string, string> = {};
    for (let i = 0; i < MAX_GENUI_UNSAFE_FIELD_NODES; i++) {
      siblings[`k${i}`] = "v";
    }
    const result = validateElizaGenUiSpec(specWithData(siblings));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "unbounded_nest"),
      ).toBe(true);
    }
  });
});
