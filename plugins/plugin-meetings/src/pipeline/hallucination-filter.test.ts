import { describe, expect, it, vi } from "vitest";
import { isHallucination } from "./hallucination-filter";

vi.mock("./hallucinations", () => ({
  HALLUCINATION_PHRASES: new Set([
    "i love you",
    "thank you for watching",
    "subscribe to my channel",
  ]),
}));

describe("isHallucination", () => {
  it("flags empty and whitespace-only text", () => {
    expect(isHallucination("")).toBe(true);
    expect(isHallucination("   ")).toBe(true);
    expect(isHallucination("\t\n")).toBe(true);
  });

  it("flags known phrases case-insensitively", () => {
    expect(isHallucination("I love you")).toBe(true);
    expect(isHallucination("THANK YOU FOR WATCHING")).toBe(true);
  });

  it("flags known phrases after trailing punctuation normalization", () => {
    expect(isHallucination("i love you.")).toBe(true);
    expect(isHallucination("i love you!")).toBe(true);
    expect(isHallucination("i love you?")).toBe(true);
    expect(isHallucination("thank you for watching...")).toBe(true);
  });

  it("passes through a normal sentence", () => {
    expect(isHallucination("please schedule the meeting for tuesday")).toBe(
      false,
    );
  });

  it("flags a single short word as junk", () => {
    expect(isHallucination("hi")).toBe(true);
    expect(isHallucination("okay")).toBe(true);
  });

  it("keeps a single long word", () => {
    expect(isHallucination("supercalifragilistic")).toBe(false);
  });

  it("keeps a short multi-word phrase", () => {
    expect(isHallucination("hello world")).toBe(false);
  });

  it("flags a 3-word phrase repeated 3 times", () => {
    const repeated = "abc def ghi abc def ghi abc def ghi";
    expect(isHallucination(repeated)).toBe(true);
  });

  it("flags a 4-word phrase repeated 3 times", () => {
    const repeated = "one two three four one two three four one two three four";
    expect(isHallucination(repeated)).toBe(true);
  });

  it("keeps a phrase repeated only twice", () => {
    expect(isHallucination("abc def ghi abc def ghi")).toBe(false);
  });

  it("keeps near-repetition with a differing tail", () => {
    expect(isHallucination("abc def ghi abc def ghi abc def xyz")).toBe(false);
  });

  it("flags a 6-word phrase repeated 3 times at the length boundary", () => {
    const repeated =
      "alpha beta gamma delta epsilon zeta alpha beta gamma delta epsilon zeta alpha beta gamma delta epsilon zeta";
    expect(isHallucination(repeated)).toBe(true);
  });
});
