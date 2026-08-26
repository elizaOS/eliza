/**
 * Locks the package's two canonical JSON compatibility policies to independent
 * byte and digest vectors, including their intentionally different undefined
 * handling.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalDeletionArtifactJson,
  canonicalProgressiveContentJson,
} from "./canonical-json.ts";

describe("canonical corpus JSON", () => {
  it("preserves progressive-content bytes and UTF-16 code-unit key order", () => {
    const bytes = canonicalProgressiveContentJson({
      z: [true, null, "text", -0],
      "\u{10000}": 2,
      "\uE000": 1,
      a: { two: 2, one: 1 },
    });

    expect(bytes).toBe(
      '{"a":{"one":1,"two":2},"z":[true,null,"text",0],"𐀀":2,"":1}',
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "fca4a872a2d8aab3e08e00b717715a388113ff981ce51d1e20232c5fe1b7642e",
    );
  });

  it("preserves deletion-artifact omission of undefined object fields", () => {
    const bytes = canonicalDeletionArtifactJson({
      retained: ["one", { value: true }],
      omitted: undefined,
    });

    expect(bytes).toBe('{"retained":["one",{"value":true}]}');
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "59706346ce7c7b96986e4cc0f39d73914189c72ceb58754e16d4d8a98f1e165f",
    );
  });

  it.each([
    ["undefined", undefined],
    ["non-finite number", Number.NaN],
    ["bigint", 1n],
    ["array undefined", [undefined]],
    ["sparse array", Array(1)],
  ])("rejects unsupported %s values", (_name, value) => {
    expect(() => canonicalProgressiveContentJson(value)).toThrow(
      /does not support/u,
    );
    expect(() => canonicalDeletionArtifactJson(value)).toThrow(
      /does not support/u,
    );
  });

  it("rejects cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalProgressiveContentJson(cyclic)).toThrow(/cycle/u);
  });
});
