/** Tests deterministic cross-platform serialization for remote control. */
import { describe, expect, it } from "vitest";
import { canonicalizeRemoteControlValue } from "./remote-control";

describe("canonicalizeRemoteControlValue", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalizeRemoteControlValue({
        z: [{ b: 2, a: 1 }],
        a: "hello",
        omitted: undefined,
      }),
    ).toBe('{"a":"hello","z":[{"a":1,"b":2}]}');
  });

  it("rejects values that cannot be signed as canonical JSON", () => {
    expect(() => canonicalizeRemoteControlValue(Number.NaN)).toThrow(
      "Non-finite JSON number",
    );
    expect(() => canonicalizeRemoteControlValue(Symbol("bad"))).toThrow(
      "Unsupported canonical JSON value",
    );
  });
});
