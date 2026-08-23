/**
 * Regression for canonical integer parsing in responseContentLength.
 */
import { describe, expect, it } from "vitest";
import { responseContentLength } from "./server-helpers-fetch.ts";

function headers(value: string | null): Pick<Headers, "get"> {
  return { get: (name: string) => (name === "content-length" ? value : null) };
}

describe("responseContentLength canonical", () => {
  it("accepts canonical 0 and positive integers", () => {
    expect(responseContentLength(headers("0"))).toBe(0);
    expect(responseContentLength(headers("123"))).toBe(123);
    expect(responseContentLength(headers(" 123 "))).toBe(123);
  });
  it("rejects non-canonical forms that parseInt would accept", () => {
    expect(responseContentLength(headers("012"))).toBeNull();
    expect(responseContentLength(headers("00"))).toBeNull();
    expect(responseContentLength(headers("123junk"))).toBeNull();
    expect(responseContentLength(headers("1e2"))).toBeNull();
    expect(responseContentLength(headers("0x10"))).toBeNull();
    expect(responseContentLength(headers("12.3"))).toBeNull();
    expect(responseContentLength(headers("+123"))).toBeNull();
    expect(responseContentLength(headers("-5"))).toBeNull();
  });
  it("old parseInt would have accepted prefix", () => {
    expect(Number.parseInt("123junk", 10)).toBe(123);
    expect(Number.parseInt("1e2", 10)).toBe(1);
    expect(Number.parseInt("012", 10)).toBe(12);
  });
});
