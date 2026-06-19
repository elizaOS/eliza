import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetBuildVariantForTests,
  DEFAULT_BUILD_VARIANT,
  getBuildVariant,
  isDirectBuild,
  isStoreBuild,
} from "./build-variant";

const originalEnv = process.env.ELIZA_BUILD_VARIANT;

beforeEach(() => {
  _resetBuildVariantForTests();
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.ELIZA_BUILD_VARIANT;
  } else {
    process.env.ELIZA_BUILD_VARIANT = originalEnv;
  }
  _resetBuildVariantForTests();
});

describe("getBuildVariant", () => {
  it('returns "store" when ELIZA_BUILD_VARIANT=store', () => {
    process.env.ELIZA_BUILD_VARIANT = "store";
    expect(getBuildVariant()).toBe("store");
    expect(isStoreBuild()).toBe(true);
    expect(isDirectBuild()).toBe(false);
  });

  it('returns "direct" when ELIZA_BUILD_VARIANT=direct', () => {
    process.env.ELIZA_BUILD_VARIANT = "direct";
    expect(getBuildVariant()).toBe("direct");
    expect(isDirectBuild()).toBe(true);
    expect(isStoreBuild()).toBe(false);
  });

  it("falls back to direct when env var is unset", () => {
    delete process.env.ELIZA_BUILD_VARIANT;
    expect(getBuildVariant()).toBe("direct");
    expect(DEFAULT_BUILD_VARIANT).toBe("direct");
  });

  it("falls back to direct on unrecognized values", () => {
    process.env.ELIZA_BUILD_VARIANT = "sandbox";
    expect(getBuildVariant()).toBe("direct");
  });
});
