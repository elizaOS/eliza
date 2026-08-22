/** Verifies build-variant resolution and direct-download policy with a mocked environment reader. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBuildVariantForTests,
  getBuildVariant,
  getDirectDownloadUrl,
  isDirectBuild,
  isStoreBuild,
} from "../build-variant.ts";

const envRead = vi.fn();

vi.mock("../utils/read-env.ts", () => ({
  readEnv: (...args: unknown[]) => envRead(...args),
}));

describe("build-variant resolution", () => {
  beforeEach(() => {
    _resetBuildVariantForTests();
    envRead.mockReset();
  });

  afterEach(() => {
    _resetBuildVariantForTests();
  });

  it("defaults to direct when ELIZA_BUILD_VARIANT is unset", () => {
    envRead.mockReturnValue(undefined);
    expect(getBuildVariant()).toBe("direct");
    expect(isDirectBuild()).toBe(true);
    expect(isStoreBuild()).toBe(false);
  });

  it("accepts the store variant", () => {
    envRead.mockReturnValue("store");
    expect(getBuildVariant()).toBe("store");
    expect(isStoreBuild()).toBe(true);
    expect(isDirectBuild()).toBe(false);
  });

  it("falls back to direct on unknown values", () => {
    envRead.mockReturnValue("unknown-variant");
    expect(getBuildVariant()).toBe("direct");
  });

  it("normalizes case and whitespace", () => {
    envRead.mockReturnValue("  STORE  ");
    expect(getBuildVariant()).toBe("store");
  });

  it("returns a stable download URL", () => {
    expect(getDirectDownloadUrl()).toBe("https://eliza.so/download");
  });

  it("caches the resolved variant across calls", () => {
    envRead.mockReturnValue("store");
    expect(getBuildVariant()).toBe("store");
    // After resolution, changing the env has no effect until reset.
    envRead.mockReturnValue("direct");
    expect(getBuildVariant()).toBe("store");
    _resetBuildVariantForTests();
    expect(getBuildVariant()).toBe("direct");
  });
});
