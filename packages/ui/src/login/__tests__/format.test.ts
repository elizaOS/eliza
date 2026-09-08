/** Exercises address previews used by linked-account controls with deterministic inputs. */
import { describe, expect, test } from "vitest";
import { truncateAddress } from "../utils/format.js";

describe("truncateAddress", () => {
  test("truncates a full 0x address with default 4 chars each side", () => {
    expect(truncateAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234...5678",
    );
  });

  test("respects a custom char count", () => {
    expect(
      truncateAddress("0x1234567890abcdef1234567890abcdef12345678", 6),
    ).toBe("0x123456...345678");
  });

  test("returns the input unchanged when shorter than the threshold", () => {
    // chars*2 + 2 = 10, so a 10-char string is returned as-is.
    expect(truncateAddress("0x12345678")).toBe("0x12345678");
  });

  test("returns input unchanged for an empty string", () => {
    expect(truncateAddress("")).toBe("");
  });
});
