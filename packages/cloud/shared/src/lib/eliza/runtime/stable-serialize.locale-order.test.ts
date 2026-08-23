/**
 * Pins `stableSerialize` to UTF-16 code-unit key ordering. Its output feeds the
 * sha1 runtime settings signature, so the same settings object must serialize
 * identically on every host. The existing suite only compares two insertion
 * orders through the same sorter, which passes under ICU collation too; these
 * cases assert the exact serialized order and cover keys that ICU ranks equal.
 */
import { describe, expect, test } from "bun:test";

import { stableSerialize } from "./stable-serialize";

const NFC_KEY = "caf\u00e9"; // precomposed U+00E9
const NFD_KEY = "cafe\u0301"; // decomposed "e" + U+0301

describe("stableSerialize canonical key order", () => {
  test("orders mixed-case keys by code unit, not by locale collation", () => {
    // ICU puts "a" before "B"; code unit puts "B" (0x42) before "a" (0x61).
    expect(stableSerialize({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  test("orders non-ASCII keys by code unit, not by locale collation", () => {
    expect(stableSerialize({ "\u00e4": 1, z: 2 })).toBe('{"z":2,"\u00e4":1}');
  });

  test("applies code-unit ordering to nested objects", () => {
    expect(stableSerialize({ nested: { a: 1, B: 2 }, A: 3 })).toBe(
      '{"A":3,"nested":{"B":2,"a":1}}',
    );
  });

  test("gives canonically equivalent distinct keys a total, insertion-independent order", () => {
    expect(stableSerialize({ [NFC_KEY]: 1, [NFD_KEY]: 2 })).toBe(
      stableSerialize({ [NFD_KEY]: 2, [NFC_KEY]: 1 }),
    );
  });
});
