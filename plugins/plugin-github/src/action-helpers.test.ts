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
 * This deterministic unit harness calls the production helpers directly; no
 * Octokit or runtime mock stands in for splitRepo.
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
  const expected = { owner: "elizaOS", name: "eliza" };

  it.each([
    "elizaOS/eliza",
    "  elizaOS/eliza  ",
    "elizaOS/eliza.git",
    "github.com/elizaOS/eliza",
    "https://github.com/elizaOS/eliza",
    "http://github.com/elizaOS/eliza",
    "HTTPS://GITHUB.COM/elizaOS/eliza",
    "https://github.com/elizaOS/eliza/",
    "https://github.com/elizaOS/eliza.git/",
    "https://github.com/elizaOS/eliza?tab=readme",
    "https://github.com/elizaOS/eliza?query=hello world",
    "https://github.com/elizaOS/eliza#readme",
    "https://github.com/elizaOS/eliza.git?tab=readme#install",
    "https://github.com:443/elizaOS/eliza",
    "http://github.com:80/elizaOS/eliza",
  ])("parses %s", (input) => {
    expect(splitRepo(input)).toEqual(expected);
  });

  it.each([
    "",
    "noslash",
    "a/b/c",
    "/eliza",
    "elizaOS/",
    "elizaOS//eliza",
    "elizaOS/eliza/",
    "elizaOS/eliza?tab=readme",
    "elizaOS /eliza",
    "elizaOS/el iza",
    "https://github.com/elizaOS/eliza/issues",
    "https://github.com/elizaOS/eliza//",
    "https://user@github.com/elizaOS/eliza",
    "https://user:token@github.com/elizaOS/eliza",
    "https://@github.com/elizaOS/eliza",
    "https://github.com:8443/elizaOS/eliza",
    "https://www.github.com/elizaOS/eliza",
    "https://api.github.com/elizaOS/eliza",
    "https://github.example.com/elizaOS/eliza",
    "https://github.com.evil.test/elizaOS/eliza",
    "ftp://github.com/elizaOS/eliza",
    "git://github.com/elizaOS/eliza",
    "ssh://git@github.com/elizaOS/eliza",
    "https:github.com/elizaOS/eliza",
    "https://github.com/elizaOS/eliza%20repo",
    "https://github.com/elizaOS/eliza%2Frepo",
    "https://github.com/elizaOS\\eliza",
    "-elizaOS/eliza",
    "elizaOS-/eliza",
    "eliza--OS/eliza",
    `${"a".repeat(40)}/eliza`,
    "elizaOS/eli@za",
    `elizaOS/${"a".repeat(101)}`,
    "elizaOS/.",
    "elizaOS/..",
    "elizaOS/.git",
  ])("rejects malformed locator %s", (input) => {
    expect(splitRepo(input)).toBeNull();
  });
});

describe("isConfirmed", () => {
  it("is always false regardless of the supplied flag", () => {
    expect(isConfirmed({ confirmed: true })).toBe(false);
    expect(isConfirmed(undefined)).toBe(false);
  });
});
