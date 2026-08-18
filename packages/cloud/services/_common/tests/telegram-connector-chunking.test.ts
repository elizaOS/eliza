/**
 * Deterministic tests for Telegram connector chunk limits: lone-surrogate
 * slices and non-advancing maxLength used to hang or emit ill-formed UTF-16.
 */

import { describe, expect, test } from "bun:test";
import { splitTelegramMessage } from "../src/telegram-connector";

const INVALID_LIMITS = [
  1,
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

describe("splitTelegramMessage surrogate-safe chunking", () => {
  test("keeps surrogate pairs intact across the Telegram 4096-unit limit", () => {
    const text = `a${"🙂".repeat(4096)}`;
    const chunks = splitTelegramMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk.toWellFormed()).toBe(chunk);
    }
  });

  test("makes nonempty, lossless progress at the minimum limit", () => {
    const text = "😀😀x";
    const chunks = splitTelegramMessage(text, 2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 2)).toBe(
      true,
    );
    expect(chunks.every((chunk) => chunk.toWellFormed() === chunk)).toBe(true);
  });

  test("rejects unsafe chunk limits before splitting", () => {
    for (const limit of INVALID_LIMITS) {
      expect(() => splitTelegramMessage("😀x", limit)).toThrow(RangeError);
    }
  });

  test("still splits ASCII lines at the default Telegram limit", () => {
    const chunks = splitTelegramMessage(`${"a".repeat(4096)}\nb`);
    expect(chunks).toEqual(["a".repeat(4096), "b"]);
  });
});
