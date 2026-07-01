import { describe, expect, it } from "vitest";
import {
  isConfirmed,
  optionalStringArray,
  requireNumber,
  requireString,
  requireStringArray,
  splitRepo,
} from "./action-helpers.ts";

/**
 * Param-validation helpers run at the GitHub action boundary on
 * LLM-/caller-supplied options. They must return null/undefined on anything
 * malformed (so a bad param can't reach the GitHub API as a half-valid call),
 * and isConfirmed must ALWAYS be false — LLM `confirmed` is never authoritative;
 * the runtime confirmation gate is the real check.
 */

describe("requireString", () => {
  it("returns non-empty strings, null otherwise", () => {
    expect(requireString({ a: "x" }, "a")).toBe("x");
    expect(requireString({ a: "" }, "a")).toBeNull();
    expect(requireString({ a: 5 }, "a")).toBeNull();
    expect(requireString(undefined, "a")).toBeNull();
  });
});

describe("requireNumber", () => {
  it("accepts integers and numeric strings, rejects the rest", () => {
    expect(requireNumber({ n: 42 }, "n")).toBe(42);
    expect(requireNumber({ n: "7" }, "n")).toBe(7);
    expect(requireNumber({ n: 1.5 }, "n")).toBeNull();
    expect(requireNumber({ n: "x" }, "n")).toBeNull();
  });
});

describe("requireStringArray / optionalStringArray", () => {
  it("requires an all-non-empty-string array", () => {
    expect(requireStringArray({ a: ["x", "y"] }, "a")).toEqual(["x", "y"]);
    expect(requireStringArray({ a: ["x", ""] }, "a")).toBeNull();
    expect(requireStringArray({ a: ["x", 1] }, "a")).toBeNull();
    expect(requireStringArray({ a: "x" }, "a")).toBeNull();
  });

  it("optionalStringArray returns undefined when the key is absent", () => {
    expect(optionalStringArray({}, "a")).toBeUndefined();
    expect(optionalStringArray({ a: ["x"] }, "a")).toEqual(["x"]);
    expect(optionalStringArray({ a: ["x", ""] }, "a")).toBeUndefined();
  });
});

describe("splitRepo", () => {
  it("splits owner/repo, null on malformed", () => {
    expect(splitRepo("elizaOS/eliza")).toEqual({
      owner: "elizaOS",
      name: "eliza",
    });
    expect(splitRepo("noslash")).toBeNull();
    expect(splitRepo("a/b/c")).toBeNull();
    expect(splitRepo("/eliza")).toBeNull();
  });
});

describe("isConfirmed", () => {
  it("is always false regardless of the supplied flag", () => {
    expect(isConfirmed({ confirmed: true })).toBe(false);
    expect(isConfirmed(undefined)).toBe(false);
  });
});
