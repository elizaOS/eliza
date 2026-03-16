import { describe, expect, it } from "vitest";
import { computeStreamingDelta, mergeStreamingText } from "./parsers";

describe("computeStreamingDelta", () => {
  it.each([
    {
      name: "returns empty for empty incoming text",
      existing: "hello",
      incoming: "",
      expected: "",
    },
    {
      name: "returns the full incoming text when nothing is accumulated yet",
      existing: "",
      incoming: "hello",
      expected: "hello",
    },
    {
      name: "returns empty when incoming matches the accumulated text",
      existing: "hello",
      incoming: "hello",
      expected: "",
    },
    {
      name: "returns only the new suffix when incoming extends existing",
      existing: "hello",
      incoming: "hello world",
      expected: " world",
    },
    {
      name: "returns empty when incoming is already a large suffix of existing",
      existing: "streaming",
      incoming: "aming",
      expected: "",
    },
    {
      name: "returns the incoming text when there is no overlap",
      existing: "hello",
      incoming: "world",
      expected: "world",
    },
    {
      name: "returns only the non-overlapping tail for partial suffix-prefix overlap",
      existing: "hello world",
      incoming: "world!",
      expected: "!",
    },
    {
      name: "preserves repeated single-character deltas",
      existing: "Hel",
      incoming: "l",
      expected: "l",
    },
    {
      name: "surfaces full snapshot replacements for in-place consumers",
      existing: "world",
      incoming: "Hello world",
      expected: "Hello world",
    },
    {
      name: "surfaces corrected full snapshots that revise earlier words",
      existing: "Hello wrld",
      incoming: "Hello world",
      expected: "Hello world",
    },
  ])("$name", ({ existing, incoming, expected }) => {
    expect(computeStreamingDelta(existing, incoming)).toBe(expected);
  });
});

describe("mergeStreamingText", () => {
  it.each([
    {
      name: "appends plain deltas",
      existing: "Hello",
      incoming: " world",
      expected: "Hello world",
    },
    {
      name: "accepts cumulative snapshots",
      existing: "Hello",
      incoming: "Hello world",
      expected: "Hello world",
    },
    {
      name: "replaces with a revised full snapshot",
      existing: "world",
      incoming: "Hello world",
      expected: "Hello world",
    },
    {
      name: "drops large suffix fragments already present",
      existing: "Hello world",
      incoming: "world",
      expected: "Hello world",
    },
    {
      name: "replaces corrected snapshots that share a long prefix",
      existing: "Hello wrld",
      incoming: "Hello world",
      expected: "Hello world",
    },
    {
      name: "preserves repeated single-character chunks",
      existing: "Hel",
      incoming: "l",
      expected: "Hell",
    },
    {
      name: "keeps short multi-character deltas without overlap",
      existing: "He",
      incoming: "llo",
      expected: "Hello",
    },
    {
      name: "drops repeated short suffix fragments already present",
      existing: "abc",
      incoming: "bc",
      expected: "abc",
    },
  ])("$name", ({ existing, incoming, expected }) => {
    expect(mergeStreamingText(existing, incoming)).toBe(expected);
  });
});
