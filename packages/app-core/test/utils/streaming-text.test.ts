import { describe, expect, it } from "vitest";
import {
  mergeStreamingText,
  computeStreamingDelta,
} from "../../src/utils/streaming-text";

describe("mergeStreamingText", () => {
  it("returns incoming when it starts with existing (cumulative snapshot)", () => {
    expect(mergeStreamingText("Hello", "Hello world")).toBe("Hello world");
  });

  it("returns incoming when existing is empty", () => {
    expect(mergeStreamingText("", "Hello")).toBe("Hello");
  });

  it("returns existing when incoming is empty", () => {
    expect(mergeStreamingText("Hello", "")).toBe("Hello");
  });

  it("returns existing when incoming equals existing", () => {
    expect(mergeStreamingText("Hello", "Hello")).toBe("Hello");
  });

  it("keeps existing when incoming is a prefix (regressive snapshot)", () => {
    expect(mergeStreamingText("Hello world", "Hello")).toBe("Hello world");
  });

  it("appends new portion when incoming overlaps existing suffix", () => {
    expect(mergeStreamingText("Hello wor", "world")).toBe("Hello world");
  });

  it("appends single character even when it matches last char (repeated chars)", () => {
    expect(mergeStreamingText("Hel", "l")).toBe("Hell");
  });

  it("builds up character by character correctly", () => {
    let text = "";
    for (const char of "Hello") {
      text = mergeStreamingText(text, char);
    }
    expect(text).toBe("Hello");
  });

  it("drops suffix-only resend larger than 1 character", () => {
    expect(mergeStreamingText("Hello world", "world")).toBe("Hello world");
  });

  it("replaces when incoming shares prefix >=8 chars but differs", () => {
    expect(
      mergeStreamingText(
        "The quick brown fox jumps",
        "The quick brown fox leaps",
      ),
    ).toBe("The quick brown fox leaps");
  });

  it("does not false-positive on short messages with natural overlap", () => {
    expect(mergeStreamingText("Hi", "Hi there")).toBe("Hi there");
  });

  it("returns incoming when it contains existing as substring", () => {
    expect(mergeStreamingText("Hello", "prefix Hello suffix")).toBe(
      "prefix Hello suffix",
    );
  });

  it("concatenates when no overlap detected and not a snapshot", () => {
    expect(mergeStreamingText("abc", "xyz")).toBe("abcxyz");
  });
});

describe("computeStreamingDelta", () => {
  it("returns empty string when merge result equals existing", () => {
    expect(computeStreamingDelta("Hello world", "Hello")).toBe("");
  });

  it("returns only the new portion for cumulative snapshots", () => {
    expect(computeStreamingDelta("Hello", "Hello world")).toBe(" world");
  });

  it("returns incoming for snapshot replacements", () => {
    expect(
      computeStreamingDelta(
        "The quick brown fox jumps",
        "The quick brown fox leaps",
      ),
    ).toBe("The quick brown fox leaps");
  });
});
