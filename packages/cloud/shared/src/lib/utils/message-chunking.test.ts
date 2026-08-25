/** Proves message chunk validation and exact lossless UTF-16 reassembly. */

import { describe, expect, it } from "vitest";
import { assertValidMessageChunkLength, splitMessageLosslessly } from "./message-chunking.js";

describe("message-chunking", () => {
  it("accepts a valid chunk length", () => {
    expect(() => assertValidMessageChunkLength(10)).not.toThrow();
  });

  it("rejects invalid chunk lengths", () => {
    expect(() => assertValidMessageChunkLength(1)).toThrow(RangeError);
    expect(() => assertValidMessageChunkLength(2.5)).toThrow();
    expect(() => assertValidMessageChunkLength(Number.NaN)).toThrow();
  });

  it("preserves whitespace and surrogate pairs across every boundary", () => {
    const text = `  lead\n\n${"😀".repeat(20)}\ntrail  `;
    const chunks = splitMessageLosslessly(text, 7);

    expect(chunks.every((chunk) => chunk.length <= 7)).toBe(true);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      const lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
      expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff).toBe(true);
    }
  });

  it("rejects chunk sizes that cannot make safe progress", () => {
    expect(() => splitMessageLosslessly("😀", 1)).toThrow(RangeError);
  });
});
