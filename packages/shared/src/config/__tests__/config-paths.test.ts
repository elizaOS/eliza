import { describe, expect, it } from "vitest";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths.ts";

describe("parseConfigPath", () => {
  it("parses dot notation", () => {
    expect(parseConfigPath("foo.bar.baz")).toEqual({
      ok: true,
      path: ["foo", "bar", "baz"],
    });
  });

  it("rejects empty and malformed paths", () => {
    expect(parseConfigPath("").ok).toBe(false);
    expect(parseConfigPath("  ").ok).toBe(false);
    expect(parseConfigPath("foo..bar").ok).toBe(false);
  });

  it("rejects prototype-pollution segments", () => {
    for (const bad of [
      "__proto__",
      "a.__proto__.b",
      "prototype",
      "constructor",
    ]) {
      expect(parseConfigPath(bad).ok).toBe(false);
    }
  });
});

describe("set/get/unset config paths", () => {
  it("sets and gets nested values", () => {
    const root: Record<string, unknown> = {};
    setConfigValueAtPath(root, ["a", "b"], 42);
    expect(getConfigValueAtPath(root, ["a", "b"])).toBe(42);
  });

  it("creates intermediate objects", () => {
    const root: Record<string, unknown> = {};
    setConfigValueAtPath(root, ["x", "y", "z"], "v");
    expect(getConfigValueAtPath(root, ["x", "y", "z"])).toBe("v");
  });

  it("unsets and prunes empty parents", () => {
    const root: Record<string, unknown> = { a: { b: { c: 1 } } };
    expect(unsetConfigValueAtPath(root, ["a", "b", "c"])).toBe(true);
    expect(root).toEqual({});
  });

  it("unset returns false for missing keys", () => {
    const root: Record<string, unknown> = { a: 1 };
    expect(unsetConfigValueAtPath(root, ["a", "b"])).toBe(false);
    expect(unsetConfigValueAtPath(root, ["missing"])).toBe(false);
  });

  it("get returns undefined for missing paths", () => {
    expect(getConfigValueAtPath({}, ["nope"])).toBeUndefined();
    expect(getConfigValueAtPath({ a: 1 }, ["a", "b"])).toBeUndefined();
  });
});
