/** Exercises the native-transcript enablement gate (pure decision function)
 *  and the disabled-path no-op behavior of the FFI wrapper. */
import { afterEach, describe, expect, it } from "vitest";
import {
  shouldEnableNativeTranscript,
  takePendingTranscriptAction,
} from "./mac-transcript";

describe("shouldEnableNativeTranscript", () => {
  it("is OFF by default (spike surface — DOM transcript stays the product renderer)", () => {
    expect(shouldEnableNativeTranscript({}, "darwin")).toBe(false);
    expect(
      shouldEnableNativeTranscript(
        { ELIZA_DESKTOP_NATIVE_TRANSCRIPT: "" },
        "darwin",
      ),
    ).toBe(false);
  });

  it("opts in via explicit truthy ELIZA_DESKTOP_NATIVE_TRANSCRIPT on macOS", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      expect(
        shouldEnableNativeTranscript(
          { ELIZA_DESKTOP_NATIVE_TRANSCRIPT: value },
          "darwin",
        ),
      ).toBe(true);
    }
  });

  it("stays OFF for explicit falsy values", () => {
    for (const value of ["0", "false", "no", "off", " OFF "]) {
      expect(
        shouldEnableNativeTranscript(
          { ELIZA_DESKTOP_NATIVE_TRANSCRIPT: value },
          "darwin",
        ),
      ).toBe(false);
    }
  });

  it("is gated off non-macOS platforms (the renderer dylib is darwin-only)", () => {
    expect(
      shouldEnableNativeTranscript(
        { ELIZA_DESKTOP_NATIVE_TRANSCRIPT: "1" },
        "win32",
      ),
    ).toBe(false);
    expect(
      shouldEnableNativeTranscript(
        { ELIZA_DESKTOP_NATIVE_TRANSCRIPT: "1" },
        "linux",
      ),
    ).toBe(false);
  });
});

describe("disabled-path wrappers", () => {
  const saved = process.env.ELIZA_DESKTOP_NATIVE_TRANSCRIPT;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.ELIZA_DESKTOP_NATIVE_TRANSCRIPT;
    } else {
      process.env.ELIZA_DESKTOP_NATIVE_TRANSCRIPT = saved;
    }
  });

  it("takePendingTranscriptAction is an inert null with the flag off", () => {
    delete process.env.ELIZA_DESKTOP_NATIVE_TRANSCRIPT;
    expect(takePendingTranscriptAction()).toBeNull();
  });
});
