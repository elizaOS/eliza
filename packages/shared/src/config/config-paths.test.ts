/** Exercises config path mutation against real objects, including adversarial prototype segments supplied directly to the public helpers. */

import { describe, expect, it } from "vitest";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths";

describe("config path helpers", () => {
  it("sets, reads, and removes an own nested value", () => {
    const root: Record<string, unknown> = {};

    setConfigValueAtPath(root, ["providers", "openai", "enabled"], true);

    expect(getConfigValueAtPath(root, ["providers", "openai", "enabled"])).toBe(
      true,
    );
    expect(
      unsetConfigValueAtPath(root, ["providers", "openai", "enabled"]),
    ).toBe(true);
    expect(root).toEqual({});
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects a direct %s segment before mutation",
    (segment) => {
      const root: Record<string, unknown> = {};

      expect(() =>
        setConfigValueAtPath(root, [segment, "polluted"], true),
      ).toThrow("unsafe segment");
      expect(() => getConfigValueAtPath(root, [segment])).toThrow(
        "unsafe segment",
      );
      expect(() => unsetConfigValueAtPath(root, [segment])).toThrow(
        "unsafe segment",
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it("never invokes accessors while traversing config data", () => {
    let getterCalls = 0;
    const root: Record<string, unknown> = {};
    Object.defineProperty(root, "profile", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { enabled: true };
      },
    });

    expect(() => getConfigValueAtPath(root, ["profile", "enabled"])).toThrow(
      "unsafe segment",
    );
    expect(() =>
      setConfigValueAtPath(root, ["profile", "enabled"], false),
    ).toThrow("unsafe segment");
    expect(() => unsetConfigValueAtPath(root, ["profile", "enabled"])).toThrow(
      "unsafe segment",
    );
    expect(getterCalls).toBe(0);
  });

  it("ignores inherited values and creates an own path", () => {
    const inherited = { enabled: false };
    Object.defineProperty(Object.prototype, "inheritedConfigProfile", {
      configurable: true,
      value: inherited,
    });
    try {
      const root: Record<string, unknown> = {};
      expect(
        getConfigValueAtPath(root, ["inheritedConfigProfile", "enabled"]),
      ).toBeUndefined();
      expect(
        unsetConfigValueAtPath(root, ["inheritedConfigProfile", "enabled"]),
      ).toBe(false);
      setConfigValueAtPath(root, ["inheritedConfigProfile", "enabled"], true);

      expect(
        getConfigValueAtPath(root, ["inheritedConfigProfile", "enabled"]),
      ).toBe(true);
      expect(inherited.enabled).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>)
        .inheritedConfigProfile;
    }
  });

  it("rejects exotic nested prototypes without traversing them", () => {
    const root: Record<string, unknown> = { profile: new Date() };

    expect(() =>
      setConfigValueAtPath(root, ["profile", "enabled"], true),
    ).toThrow("unsafe segment");
    expect(() => getConfigValueAtPath(root, ["profile", "enabled"])).toThrow(
      "unsafe segment",
    );
  });

  it("bounds raw and direct paths before traversal", () => {
    expect(parseConfigPath(`${"a.".repeat(40)}z`).ok).toBe(false);
    expect(parseConfigPath("a".repeat(129)).ok).toBe(false);
    expect(() =>
      setConfigValueAtPath(
        {},
        [...Array.from({ length: 33 }, () => "a")],
        true,
      ),
    ).toThrow("unsafe segment");
  });
});
