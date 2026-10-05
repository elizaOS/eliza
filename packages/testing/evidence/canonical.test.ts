import { expect, it, vi } from "vitest";
import { canonicalJson, canonicalJsonBytes } from "./canonical.ts";

it.each(
  [Array(1), Array(2), Object.assign(Array(3), { 0: 1, 2: 3 })].map((value) => [
    value,
  ]),
)(
  "rejects sparse arrays instead of losing data or emitting invalid JSON",
  (value) => {
    expect(() => canonicalJson(value)).toThrow(/defined data element/);
  },
);

it("rejects cycles and accessors without executing getters", () => {
  const value: { self?: unknown } = {};
  value.self = value;
  expect(() => canonicalJson(value)).toThrow(/cycle/);
  const getter = vi.fn(() => "unstable");
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: getter,
  });
  expect(() => canonicalJson(accessor)).toThrow(/accessor/);
  const array = Object.defineProperty([1], "0", { get: getter });
  expect(() => canonicalJson(array)).toThrow(/defined data element/);
  expect(getter).not.toHaveBeenCalled();
});

it("preserves canonical signed bytes and permits repeated acyclic references", () => {
  const shared = { z: 1, a: "é", omitted: undefined };
  expect(canonicalJsonBytes({ b: shared, a: shared }).toString()).toBe(
    '{"a":{"a":"é","z":1},"b":{"a":"é","z":1}}\n',
  );
});
