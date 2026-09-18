/** Exercises build selection and local-execution admission through the real environment reader. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetBuildVariantForTests,
  getBuildVariant,
  isDirectBuild,
  isStoreBuild,
} from "./build-variant.js";
import {
  buildStoreVariantBlockedMessage,
  isLocalCodeExecutionAllowed,
} from "./sandbox-policy.js";

afterEach(() => {
  vi.unstubAllEnvs();
  _resetBuildVariantForTests();
});

describe("build variant and sandbox policy", () => {
  it.each([
    { value: undefined, expected: "direct" },
    { value: "direct", expected: "direct" },
    { value: "store", expected: "store" },
    { value: " STORE ", expected: "store" },
    { value: "unknown-variant", expected: "direct" },
  ])(
    "resolves $value as $expected and applies its execution policy",
    ({ value, expected }) => {
      vi.stubEnv("ELIZA_BUILD_VARIANT", value);
      expect(getBuildVariant()).toBe(expected);
      expect(isDirectBuild()).toBe(expected === "direct");
      expect(isStoreBuild()).toBe(expected === "store");
      expect(isLocalCodeExecutionAllowed()).toBe(expected === "direct");
    },
  );

  it("keeps the startup policy until explicitly reset", () => {
    vi.stubEnv("ELIZA_BUILD_VARIANT", "store");
    expect(isLocalCodeExecutionAllowed()).toBe(false);
    vi.stubEnv("ELIZA_BUILD_VARIANT", "direct");
    expect(getBuildVariant()).toBe("store");
    expect(isLocalCodeExecutionAllowed()).toBe(false);
    _resetBuildVariantForTests();
    expect(isLocalCodeExecutionAllowed()).toBe(true);
  });
});

it("explains store execution restrictions with the requested feature and download route", () => {
  const message = buildStoreVariantBlockedMessage("Terminal commands");
  expect(message).toContain("Terminal commands requires");
  expect(message).toContain("Store-distributed builds");
  expect(message).toContain("https://eliza.so/download");
});
