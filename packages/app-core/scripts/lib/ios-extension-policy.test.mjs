/** Proves optional iOS extension policy is explicit and fail-closed. */
import { describe, expect, it } from "vitest";

import {
  IOS_KEYBOARD_EXTENSION_ENV,
  isIosKeyboardExtensionEnabled,
  readIosKeyboardExtensionBuildFlag,
} from "./ios-extension-policy.mjs";

describe("iOS extension build policy", () => {
  it("keeps the v2 keyboard out of default v1 builds", () => {
    expect(readIosKeyboardExtensionBuildFlag(undefined)).toBe(false);
    expect(readIosKeyboardExtensionBuildFlag("")).toBe(false);
    expect(readIosKeyboardExtensionBuildFlag("0")).toBe(false);
    expect(isIosKeyboardExtensionEnabled({})).toBe(false);
  });

  it("enables the keyboard only with the exact opt-in value", () => {
    expect(readIosKeyboardExtensionBuildFlag("1")).toBe(true);
    expect(
      isIosKeyboardExtensionEnabled({
        [IOS_KEYBOARD_EXTENSION_ENV]: "1",
      }),
    ).toBe(true);
  });

  it.each(["true", "yes", " 1 ", "false", "2"])(
    "rejects ambiguous value %j",
    (value) => {
      expect(() => readIosKeyboardExtensionBuildFlag(value)).toThrow(
        /must be "0" or "1"/,
      );
    },
  );
});
