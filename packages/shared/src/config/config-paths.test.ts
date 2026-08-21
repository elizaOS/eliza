/** Exercises config path mutation against real objects, including adversarial prototype segments supplied directly to the public helpers. */

import { describe, expect, it } from "vitest";
import {
  getConfigValueAtPath,
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
});
