/**
 * Pins the Content-Range parser the UI model downloader uses to decide whether
 * a 206 actually continues a partial file. Pure function, no I/O.
 */
import { describe, expect, it } from "vitest";
import { contentRangeStart } from "./downloader";

describe("contentRangeStart", () => {
  it("reads the start offset of a well-formed Content-Range", () => {
    expect(contentRangeStart("bytes 17-1023/1024")).toBe(17);
    expect(contentRangeStart("bytes 0-1023/1024")).toBe(0);
    expect(contentRangeStart("bytes 5-9/*")).toBe(5);
    expect(contentRangeStart(["bytes 42-99/100"])).toBe(42);
    expect(contentRangeStart("  BYTES 3-4/5 ")).toBe(3);
  });

  it("treats a missing or malformed header as not honored", () => {
    expect(contentRangeStart(undefined)).toBeNull();
    expect(contentRangeStart([])).toBeNull();
    expect(contentRangeStart("")).toBeNull();
    expect(contentRangeStart("bytes */1024")).toBeNull();
    expect(contentRangeStart("bytes=17-")).toBeNull();
    expect(contentRangeStart("items 0-9/10")).toBeNull();
  });
});
