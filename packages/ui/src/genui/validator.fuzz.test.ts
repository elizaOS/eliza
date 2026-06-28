// Fuzz / hardening pass for the generated-UI spec validator. This is the
// boundary that accepts agent-authored (untrusted) UI specs, so the invariant
// under arbitrary input is: validateElizaGenUiSpec NEVER throws and always
// returns a discriminated {ok:true, spec} | {ok:false, errors} result --
// including for deeply-nested component trees (no stack overflow). A seeded LCG
// makes failures reproducible.

import { describe, expect, it } from "vitest";
import { validateElizaGenUiSpec } from "./validator";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const KEYS = [
  "version",
  "type",
  "id",
  "components",
  "children",
  "data",
  "metadata",
  "props",
  "ref",
  "text",
  "__proto__",
];
const TYPES = ['"Text"', '"Stack"', '"Button"', '"Bogus"', "5", "null"];
const PRIMS = ["1", '"s"', "true", "false", "null", "-3.5", '""'];

function randomJson(rng: () => number, depth: number): string {
  if (depth <= 0 || rng() < 0.4) return PRIMS[Math.floor(rng() * PRIMS.length)];
  const k = 1 + Math.floor(rng() * 4);
  if (rng() < 0.45) {
    const items: string[] = [];
    for (let i = 0; i < k; i++) items.push(randomJson(rng, depth - 1));
    return `[${items.join(",")}]`;
  }
  const entries: string[] = [];
  for (let i = 0; i < k; i++) {
    const key = KEYS[Math.floor(rng() * KEYS.length)];
    const value =
      key === "type"
        ? TYPES[Math.floor(rng() * TYPES.length)]
        : randomJson(rng, depth - 1);
    entries.push(`${JSON.stringify(key)}:${value}`);
  }
  return `{${entries.join(",")}}`;
}

function assertResultShape(result: ReturnType<typeof validateElizaGenUiSpec>) {
  expect(typeof result.ok).toBe("boolean");
  if (result.ok) {
    expect(result.spec).toBeDefined();
  } else {
    expect(Array.isArray(result.errors)).toBe(true);
  }
}

describe("validateElizaGenUiSpec - fuzz", () => {
  it("never throws and always returns a well-formed result on arbitrary input", () => {
    const rng = makeRng(0x9a11d);
    for (let i = 0; i < 4000; i++) {
      const value = JSON.parse(randomJson(rng, 4)) as unknown;
      assertResultShape(validateElizaGenUiSpec(value));
    }
    // Plus the obvious non-object inputs.
    for (const v of [null, undefined, 5, "x", [], true]) {
      assertResultShape(validateElizaGenUiSpec(v));
    }
  });

  it("rejects a deeply-nested component tree without a stack overflow", () => {
    // Build a 5000-deep nested-children spec by hand (too deep to be valid, but
    // the validator must reject it gracefully, not blow the stack).
    let node = '{"type":"Text","id":"leaf"}';
    for (let i = 0; i < 5000; i++) {
      node = `{"type":"Stack","id":"n${i}","children":[${node}]}`;
    }
    const spec = `{"version":"1.0","components":[${node}]}`;
    const value = JSON.parse(spec) as unknown;
    expect(() => {
      const result = validateElizaGenUiSpec(value);
      assertResultShape(result);
    }).not.toThrow();
  });
});
