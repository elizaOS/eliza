import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  cloneWithoutBlockedObjectKeys,
  hasBlockedObjectKeyDeep,
} from "./server-helpers";

describe("blocked object key sanitization", () => {
  it("detects and removes nested prototype-pollution keys without mutating safe data", () => {
    const hostile = JSON.parse(
      '{"safe":{"value":1},"items":[{"constructor":{"prototype":{"polluted":true}}}],"prototype":"x"}',
    ) as Record<string, unknown>;

    expect(hasBlockedObjectKeyDeep(hostile)).toBe(true);

    const clean = cloneWithoutBlockedObjectKeys(hostile);

    expect(clean).toEqual({
      safe: { value: 1 },
      items: [{}],
    });
    expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
    expect(hostile).toHaveProperty("prototype", "x");
  });

  it("does not assign __proto__ while cloning hostile parsed JSON", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"ok":true}}',
    ) as Record<string, unknown>;

    const clean = cloneWithoutBlockedObjectKeys(hostile) as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(clean, "__proto__")).toBe(false);
    expect(clean).toEqual({ nested: { ok: true } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("fuzzes JSON-compatible values with blocked keys injected at arbitrary leaves", () => {
    fc.assert(
      fc.property(
        // The "legit" value must not itself contain blocked keys, otherwise the
        // sanitizer correctly strips them and clean !== the original value.
        fc.jsonValue().filter((v) => !hasBlockedObjectKeyDeep(v)),
        fc.constantFrom("__proto__", "constructor", "prototype"),
        (value, blockedKey) => {
          const payload = {
            value,
            wrapper: [{ [blockedKey]: { value: "drop me" } }],
          };

          expect(hasBlockedObjectKeyDeep(payload)).toBe(true);
          const clean = cloneWithoutBlockedObjectKeys(payload);
          const cleanValue = cloneWithoutBlockedObjectKeys(value);
          expect(hasBlockedObjectKeyDeep(clean)).toBe(false);
          expect(clean).toEqual({
            value: cleanValue,
            wrapper: [{}],
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
