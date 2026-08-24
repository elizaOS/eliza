/**
 * Pins Android runtime-mode resolution. The `android-cloud` build has no
 * on-device agent, so this is the switch that decides whether onboarding offers
 * the Local runtime path at all; only an explicit "cloud" may select the
 * cloud-locked variant, and everything else must resolve to "local". Env is
 * injected per case: the sibling isAndroidCloudBuild() reads the Vite-inlined
 * import.meta.env of its own module and is not addressable from a test, so this
 * covers the injectable resolver it delegates to rather than faking that read.
 */

import { describe, expect, it } from "vitest";
import { resolveAndroidRuntimeMode } from "./android-runtime";

const KEY = "VITE_ELIZA_ANDROID_RUNTIME_MODE";

describe("resolveAndroidRuntimeMode", () => {
  it("selects cloud only for an explicit cloud value", () => {
    expect(resolveAndroidRuntimeMode({ [KEY]: "cloud" })).toBe("cloud");
  });

  it("tolerates casing and surrounding whitespace on cloud", () => {
    for (const value of ["CLOUD", "Cloud", "  cloud  ", "\tcloud\n"]) {
      expect(resolveAndroidRuntimeMode({ [KEY]: value })).toBe("cloud");
    }
  });

  it("defaults to local when the key is missing", () => {
    expect(resolveAndroidRuntimeMode({})).toBe("local");
  });

  it("defaults to local for blank and whitespace-only values", () => {
    for (const value of ["", "   ", "\t\n"]) {
      expect(resolveAndroidRuntimeMode({ [KEY]: value })).toBe("local");
    }
  });

  it("defaults to local for an explicit local value", () => {
    for (const value of ["local", "LOCAL", " local "]) {
      expect(resolveAndroidRuntimeMode({ [KEY]: value })).toBe("local");
    }
  });

  it("defaults to local for unrecognised values rather than guessing", () => {
    for (const value of [
      "cloudy",
      "remote",
      "cloud-locked",
      "system",
      "1",
      "true",
    ]) {
      expect(resolveAndroidRuntimeMode({ [KEY]: value })).toBe("local");
    }
  });

  it("ignores non-string values", () => {
    for (const value of [true, false, undefined]) {
      expect(resolveAndroidRuntimeMode({ [KEY]: value })).toBe("local");
    }
  });

  it("ignores unrelated keys", () => {
    expect(
      resolveAndroidRuntimeMode({
        VITE_ELIZA_IOS_RUNTIME_MODE: "cloud",
        ELIZA_RUNTIME_MODE: "cloud",
        NODE_ENV: "production",
      }),
    ).toBe("local");
  });

  it("only ever returns one of the two declared modes", () => {
    const seen = new Set<string>();
    for (const value of [
      "cloud",
      "local",
      "",
      "junk",
      " CLOUD ",
      undefined,
      true,
    ]) {
      seen.add(resolveAndroidRuntimeMode({ [KEY]: value }));
    }
    expect([...seen].sort()).toEqual(["cloud", "local"]);
  });

  it("is pure — repeated calls with the same env agree", () => {
    const env = { [KEY]: "cloud" };
    expect(resolveAndroidRuntimeMode(env)).toBe(resolveAndroidRuntimeMode(env));
  });
});
