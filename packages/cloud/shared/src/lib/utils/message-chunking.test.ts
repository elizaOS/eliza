/**
 * Coverage for message-chunking.
 */
import { describe, expect, it } from "vitest";
import { assertValidMessageChunkLength } from "./message-chunking.js";
describe("message-chunking", () => {
  it("valid", () => {
    expect(() => assertValidMessageChunkLength(10)).not.toThrow();
  });
  it("throws for small", () => {
    expect(() => assertValidMessageChunkLength(1)).toThrow(RangeError);
  });
  it("throws for non-integer", () => {
    expect(() => assertValidMessageChunkLength(2.5)).toThrow();
  });
  it("throws for NaN", () => {
    expect(() => assertValidMessageChunkLength(NaN)).toThrow();
  });
});
